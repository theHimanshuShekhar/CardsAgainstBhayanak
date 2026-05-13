import { createAPIFileRoute } from '@tanstack/start-api-routes'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { redis, KEYS } from '~/lib/redis'
import { signSessionToken } from '~/lib/session-token'
import { checkRateLimit } from '~/lib/rate-limit'
import { JoinGameSchema, errorResponse, getClientIp } from '~/lib/api-helpers'
import { captureServerEvent } from '~/lib/posthog-server'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql } from 'drizzle-orm'
import type { GameConfig } from '~/lib/types'

export const APIRoute = createAPIFileRoute('/api/games/$code/join')({
  POST: async ({ request, params }) => {
    const ip = getClientIp(request)
    const rl = await checkRateLimit(`ip:${ip}:join`, 10, 60)
    if (!rl.allowed) return errorResponse(429, 'rate_limited', 'Too many join attempts')

    const code = params.code.toUpperCase()
    const exists = await redis.exists(KEYS.game(code))
    if (!exists) return errorResponse(404, 'room_not_found', 'Room not found')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse(400, 'internal_error', 'Invalid JSON')
    }
    const parsed = JoinGameSchema.safeParse(body)
    if (!parsed.success)
      return errorResponse(400, 'internal_error', 'Invalid body', parsed.error.flatten())

    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
    if (!session) return errorResponse(404, 'room_not_found', 'Room not found')
    if (session.status === 'ended' || session.status === 'abandoned')
      return errorResponse(410, 'room_not_found', 'Game has ended')

    const config = session.config as GameConfig
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
    const playerCount = Number(activePlayers?.cnt ?? 0)

    const { role } = parsed.data
    if (role === 'player' && playerCount >= config.maxPlayers)
      return errorResponse(423, 'room_full', 'Player slots full — join as spectator')

    const [dup] = await db
      .select()
      .from(gamePlayers)
      .where(
        and(
          eq(gamePlayers.sessionId, session.id),
          eq(gamePlayers.username, parsed.data.username),
          sql`${gamePlayers.status} != 'dropped'`,
        ),
      )
    if (dup) return errorResponse(409, 'duplicate_username', 'Handle taken in this room')

    const status =
      role === 'spectator'
        ? 'spectator'
        : session.status === 'active' || session.status === 'paused'
          ? 'queued'
          : 'active'

    const [player] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        username: parsed.data.username,
        role,
        status,
        posthogAnonId: parsed.data.anonId,
      })
      .returning()

    if (!player) return errorResponse(500, 'internal_error', 'Failed to create player')

    const token = await signSessionToken({ playerId: player.id, roomCode: code })

    captureServerEvent(parsed.data.anonId, 'cab_game_joined', {
      roomCode: code,
      role,
      isMidGame: session.status === 'active' || session.status === 'paused',
    })
    apiLogger.info({ roomCode: code, playerId: player.id, role, status }, 'player joined')

    return Response.json({
      playerId: player.id,
      sessionToken: token,
      status,
      gameStatus: session.status,
    })
  },
})
