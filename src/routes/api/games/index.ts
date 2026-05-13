import { createAPIFileRoute } from '@tanstack/start-api-routes'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { redis, KEYS, ROOM_TTL_SECONDS } from '~/lib/redis'
import { generateRoomCode } from '~/lib/code-gen'
import { signSessionToken } from '~/lib/session-token'
import { checkRateLimit } from '~/lib/rate-limit'
import { CreateGameSchema, errorResponse, getClientIp } from '~/lib/api-helpers'
import { captureServerEvent } from '~/lib/posthog-server'
import { apiLogger } from '~/lib/logger'
import { eq } from 'drizzle-orm'

async function allocateRoomCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRoomCode()
    const ok = await redis.set(KEYS.game(code), '1', 'EX', ROOM_TTL_SECONDS, 'NX')
    if (ok === 'OK') return code
  }
  throw new Error('Failed to allocate room code after 5 attempts')
}

export const APIRoute = createAPIFileRoute('/api/games')({
  POST: async ({ request }) => {
    const ip = getClientIp(request)
    const rl = await checkRateLimit(`ip:${ip}:create`, 5, 3600)
    if (!rl.allowed)
      return errorResponse(429, 'rate_limited', 'Too many game creations; try again later')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse(400, 'internal_error', 'Invalid JSON body')
    }
    const parsed = CreateGameSchema.safeParse(body)
    if (!parsed.success)
      return errorResponse(400, 'internal_error', 'Invalid request body', parsed.error.flatten())

    const code = await allocateRoomCode()

    const [session] = await db
      .insert(gameSessions)
      .values({ code, status: 'lobby', config: parsed.data.config })
      .returning()

    if (!session) return errorResponse(500, 'internal_error', 'Failed to create session')

    const [host] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        username: parsed.data.username,
        role: 'player',
        status: 'active',
        isHost: true,
        posthogAnonId: parsed.data.anonId,
      })
      .returning()

    if (!host) return errorResponse(500, 'internal_error', 'Failed to create host player')

    await db
      .update(gameSessions)
      .set({ hostPlayerId: host.id })
      .where(eq(gameSessions.id, session.id))

    const token = await signSessionToken({ playerId: host.id, roomCode: code })

    captureServerEvent(parsed.data.anonId, 'cab_game_created', {
      roomCode: code,
      maxPlayers: parsed.data.config.maxPlayers,
      roundsToWin: parsed.data.config.roundsToWin,
      timer: parsed.data.config.timer,
      packs: parsed.data.config.packs,
      rules: parsed.data.config.rules,
    })

    apiLogger.info({ roomCode: code, playerId: host.id }, 'game created')

    return new Response(
      JSON.stringify({ roomCode: code, playerId: host.id, sessionToken: token }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  },
})
