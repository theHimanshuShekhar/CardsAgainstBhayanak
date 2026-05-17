import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { authenticate } from '~/lib/api-auth'
import { errorResponse } from '~/lib/api-helpers'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql, count } from 'drizzle-orm'
import * as engine from '~/lib/game-engine'
import * as state from '~/lib/game-state'
import { captureServerEvent } from '~/lib/posthog-server'

export const Route = createFileRoute('/api/games/$code/start')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const auth = await authenticate(request)
        if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')

        const [session] = await db
          .select()
          .from(gameSessions)
          .where(eq(gameSessions.code, params.code))
        if (!session) return errorResponse(404, 'room_not_found', 'Room not found')
        if (session.hostPlayerId !== auth.playerId)
          return errorResponse(403, 'host_only', 'Only the host can start')
        if (session.status !== 'lobby')
          return errorResponse(409, 'invalid_state', 'Game already started')

        const [row] = await db
          .select({ cnt: sql<number>`count(*)` })
          .from(gamePlayers)
          .where(
            and(
              eq(gamePlayers.sessionId, session.id),
              eq(gamePlayers.role, 'player'),
              eq(gamePlayers.status, 'active'),
            ),
          )
        if (Number(row?.cnt ?? 0) < 3)
          return errorResponse(409, 'invalid_state', 'Need at least 3 players')

        await engine.startGame(params.code)

        // N-1: the engine is the sole emitter of `round_started`
        // (inside startRound). Emit `game_started` first so clients see
        // the correct game_started → round_started ordering.
        const round = 1
        await state.publishEvent(params.code, { type: 'game_started', firstRound: round })
        await engine.startRound(params.code, round)

        const [spectators] = await db
          .select({ cnt: count() })
          .from(gamePlayers)
          .where(and(eq(gamePlayers.sessionId, session.id), eq(gamePlayers.role, 'spectator')))

        const hostPlayer = await db
          .select({ posthogAnonId: gamePlayers.posthogAnonId })
          .from(gamePlayers)
          .where(and(eq(gamePlayers.sessionId, session.id), eq(gamePlayers.id, auth.playerId)))
          .then((r) => r[0])

        if (hostPlayer?.posthogAnonId) {
          captureServerEvent(hostPlayer.posthogAnonId, 'cab_game_started', {
            roomCode: params.code,
            playerCount: Number(row?.cnt ?? 0),
            spectatorCount: Number(spectators?.cnt ?? 0),
          })
        }

        apiLogger.info({ roomCode: params.code }, 'game started')

        return new Response(null, { status: 204 })
      },
    },
  },
})
