import { createAPIFileRoute } from '@tanstack/start-api-routes'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { authenticate } from '~/lib/api-auth'
import { errorResponse } from '~/lib/api-helpers'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql, count } from 'drizzle-orm'
import * as engine from '~/lib/game-engine'
import * as state from '~/lib/game-state'
import { captureServerEvent } from '~/lib/posthog-server'

export const APIRoute = createAPIFileRoute('/api/games/$code/start')({
  POST: async ({ request, params }) => {
    const auth = await authenticate(request)
    if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')

    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, params.code))
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

    const round = 1
    const { prompt, czarId } = await engine.startRound(params.code, round)

    await state.publishEvent(params.code, { type: 'game_started', firstRound: round })
    await state.publishEvent(params.code, { type: 'round_started', round, prompt, czarId })

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
})
