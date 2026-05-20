import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions } from '~/db/schema'
import { authenticate } from '~/lib/api-auth'
import { GameConfigSchema, conflictingModalRules, errorResponse } from '~/lib/api-helpers'
import { apiLogger } from '~/lib/logger'
import { eq } from 'drizzle-orm'
import * as state from '~/lib/game-state'
import type { SessionStatus } from '~/lib/types'

export const Route = createFileRoute('/api/games/$code/config')({
  server: {
    handlers: {
      // #3: host edits the room config from the lobby (packs / rules /
      // points / timer). Same validation as create; only while 'lobby'.
      PATCH: async ({ request, params }) => {
        const auth = await authenticate(request)
        if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')

        const code = params.code.toUpperCase()

        let body: unknown
        try {
          body = await request.json()
        } catch {
          return errorResponse(400, 'internal_error', 'Invalid JSON body')
        }
        const parsed = GameConfigSchema.safeParse((body as { config?: unknown }).config)
        if (!parsed.success)
          return errorResponse(400, 'internal_error', 'Invalid config', parsed.error.flatten())

        const activeModal = conflictingModalRules(parsed.data.rules)
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

        await db
          .update(gameSessions)
          .set({ config: parsed.data })
          .where(eq(gameSessions.id, session.id))

        // Refresh every connected lobby client with the new config.
        await state.publishEvent(code, {
          type: 'lobby_snapshot',
          players: await state.getAllPlayers(code),
          config: parsed.data,
          gameStatus: session.status as SessionStatus,
        })

        apiLogger.info({ roomCode: code }, 'lobby config updated')
        return new Response(null, { status: 204 })
      },
    },
  },
})
