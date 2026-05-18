import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { redis, KEYS } from '~/lib/redis'
import * as state from '~/lib/game-state'
import * as engine from '~/lib/game-engine'
import { signSessionToken } from '~/lib/session-token'
import { enforceRateLimit } from '~/lib/rate-limit'
import { JoinGameSchema, errorResponse, getClientIp } from '~/lib/api-helpers'
import { captureServerEvent } from '~/lib/posthog-server'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql } from 'drizzle-orm'
import type { GameConfig, SessionStatus } from '~/lib/types'

export const Route = createFileRoute('/api/games/$code/join')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const ip = getClientIp(request)
        const rl = await enforceRateLimit(`ip:${ip}:join`, 10, 60)
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

        // S2-8: a 'paused' session is deserted — a joiner must come in
        // 'active' (not 'queued' behind nobody) so resumeIfReady can
        // restart the round. Only a live 'active' game queues mid-game
        // joiners for round_end activation.
        const status =
          role === 'spectator' ? 'spectator' : session.status === 'active' ? 'queued' : 'active'

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

        const gamePlayer = {
          id: player.id,
          username: player.username,
          role,
          status,
          score: 0,
          isHost: false,
          isRando: false,
          discardsUsed: 0,
          posthogAnonId: parsed.data.anonId,
          joinedAt: player.joinedAt.toISOString(),
        } as const
        await state.addPlayer(code, gamePlayer)
        await state.publishEvent(code, { type: 'player_joined', player: gamePlayer })

        // S2-8: this join may make a paused room playable again. resume
        // flips it back to 'active' and re-arms a round, so report the
        // post-resume status to the client.
        let gameStatus: SessionStatus = session.status
        if (role === 'player' && session.status === 'paused') {
          await engine.resumeIfReady(code)
          const [fresh] = await db
            .select({ status: gameSessions.status })
            .from(gameSessions)
            .where(eq(gameSessions.id, session.id))
          if (fresh) gameStatus = fresh.status
        }

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
          gameStatus,
        })
      },
    },
  },
})
