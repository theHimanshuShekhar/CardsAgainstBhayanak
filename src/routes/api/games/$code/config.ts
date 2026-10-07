import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { authenticate } from '~/lib/api-auth'
import { GameConfigSchema, conflictingModalRules, errorResponse } from '~/lib/api-helpers'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql } from 'drizzle-orm'
import { z } from 'zod'
import * as state from '~/lib/game-state'
import type { SessionStatus } from '~/lib/types'

const ConfigRequestSchema = z.object({ config: GameConfigSchema })

export const Route = createFileRoute('/api/games/$code/config')({
  server: {
    handlers: {
      // #3: host edits the room config from the lobby (packs / rules /
      // points / timer). Same validation as create; only while 'lobby'.
      PATCH: async ({ request, params }) => {
        const auth = await authenticate(request, params.code.toUpperCase())
        if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')

        const code = params.code.toUpperCase()

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse(400, 'internal_error', 'Invalid JSON body')
        }
        const parsed = ConfigRequestSchema.safeParse(body)
        if (!parsed.success)
          return errorResponse(400, 'internal_error', 'Invalid config', parsed.error.flatten())
        const config = parsed.data.config

        const activeModal = conflictingModalRules(config.rules)
        if (activeModal.length > 1)
          return errorResponse(
            400,
            'conflicting_rules',
            'Only one modal rule (God Is Dead / Survival / Serious Business) may be enabled',
            { rules: activeModal },
          )

        const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
        if (!session) return errorResponse(404, 'room_not_found', 'Room not found')
        if (session.hostPlayerId !== auth.playerId)
          return errorResponse(403, 'host_only', 'Only the host can change the config')
        if (session.status !== 'lobby')
          return errorResponse(409, 'invalid_state', 'Config can only change in the lobby')

        // S3-NEW-C: maxPlayers must not drop below the current player-role
        // roster — otherwise the next join sees a phantom "room full" and
        // the existing lobby UI shows more chips than the new cap allows.
        // Zod already enforces the absolute 3..10 bound; this is the
        // dynamic floor based on who's already in the room.
        const [activePlayers] = await db
          .select({ cnt: sql<number>`count(*)` })
          .from(gamePlayers)
          .where(
            and(
              eq(gamePlayers.sessionId, session.id),
              eq(gamePlayers.role, 'player'),
              sql`${gamePlayers.status} != 'dropped'`,
            ),
          )
        const rosterSize = Number(activePlayers?.cnt ?? 0)
        if (config.maxPlayers < rosterSize)
          return errorResponse(
            409,
            'invalid_state',
            `Cannot set maxPlayers below current roster (${rosterSize})`,
            { rosterSize, requested: config.maxPlayers },
          )

        if (!(await authenticate(request, code)))
          return errorResponse(401, 'not_authorized', 'Missing or invalid token')
        await state.updateLiveRoom(code, {}, auth.playerId)
        await db
          .update(gameSessions)
          .set({ config, lastActivityAt: new Date() })
          .where(eq(gameSessions.id, session.id))

        // Refresh every connected lobby client with the new config.
        await state.publishEvent(code, {
          type: 'lobby_snapshot',
          players: await state.getAllPlayers(code),
          config,
          gameStatus: session.status as SessionStatus,
        })

        apiLogger.info({ roomCode: code }, 'lobby config updated')
        return new Response(null, { status: 204 })
      },
    },
  },
})
