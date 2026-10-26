import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { redis, KEYS, ROOM_TTL_SECONDS } from '~/lib/redis'
import { ROOM_LIFETIME_LUA } from '~/lib/room-lifetime'
import * as state from '~/lib/game-state'
import * as engine from '~/lib/game-engine'
import { signSessionToken } from '~/lib/session-token'
import { enforceRateLimit } from '~/lib/rate-limit'
import { JoinGameSchema, errorResponse } from '~/lib/api-helpers'
import { getClientIp } from '~/lib/client-identity.server'
import { captureServerEvent } from '~/lib/posthog-server'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql } from 'drizzle-orm'
import type { GameConfig, GamePlayer, PlayerStatus, Role, SessionStatus } from '~/lib/types'

type Admission = {
  session: typeof gameSessions.$inferSelect
  player: typeof gamePlayers.$inferSelect
  role: Role
  status: PlayerStatus
  gamePlayer: GamePlayer
  token: string
}

// Pending IDs survive an uncertain COMMIT or process exit. Holding the room
// row lock ensures each previous transaction has finished before reconciliation.
async function reconcileAdmissions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  code: string,
): Promise<void> {
  for (const field of await redis.hkeys(KEYS.game(code))) {
    if (!field.startsWith('admission:')) continue
    const playerId = field.slice('admission:'.length)
    const [row] = await tx
      .select({ id: gamePlayers.id })
      .from(gamePlayers)
      .where(eq(gamePlayers.id, playerId))
    if (!row) await redis.hdel(KEYS.players(code), playerId)
    await redis.hdel(KEYS.game(code), field)
  }
}

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

        // The session row serializes admission and lobby configuration across
        // server processes. Read authoritative Redis membership only after locking,
        // and publish membership before releasing the lock to the next contender.
        let prepared: Admission | undefined
        const admission = await db
          .transaction(async (tx) => {
            const [session] = await tx
              .select()
              .from(gameSessions)
              .where(eq(gameSessions.code, code))
              .for('update')
            if (!session) return errorResponse(404, 'room_not_found', 'Room not found')
            if (!(await redis.exists(KEYS.game(code))))
              return errorResponse(404, 'room_not_found', 'Room not found')
            if (session.status === 'ended' || session.status === 'abandoned')
              return errorResponse(410, 'room_not_found', 'Game has ended')

            await reconcileAdmissions(tx, code)
            const config = session.config as GameConfig
            const livePlayers = await state.getLivePlayers(code)
            const playerCount = livePlayers.filter((player) => player.role === 'player').length

            const { role } = parsed.data
            if (role === 'player' && playerCount >= config.maxPlayers)
              return errorResponse(423, 'room_full', 'Player slots full — join as spectator')

            const [dup] = await tx
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

            const [player] = await tx
              .insert(gamePlayers)
              .values({
                sessionId: session.id,
                username: parsed.data.username,
                role,
                status,
                posthogAnonId: parsed.data.anonId,
              })
              // Reuse creates a new identity; departed tokens/outcomes stay bound
              // to the old row. The index uses the same live-membership policy.
              .onConflictDoNothing({
                target: [gamePlayers.sessionId, gamePlayers.username],
                where: sql`${gamePlayers.status} != 'dropped'`,
              })
              .returning()

            if (!player)
              return errorResponse(409, 'duplicate_username', 'Handle taken in this room')

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
            const token = await signSessionToken({ playerId: player.id, roomCode: code })
            prepared = { session, player, role, status, gamePlayer, token }
            // Keep the pending ID on the room itself so it survives exactly
            // as long as the live room. Publish marker and member atomically.
            const added = await redis.eval(
              `${ROOM_LIFETIME_LUA}
              if not redis.call('EXISTS', KEYS[1]) then return 0 end
              redis.call('HSET', KEYS[1], ARGV[1], 'pending')
              redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
              renewRoomState(KEYS[1])
              return 1
            `,
              2,
              KEYS.game(code),
              KEYS.players(code),
              `admission:${player.id}`,
              player.id,
              JSON.stringify(gamePlayer),
              ROOM_TTL_SECONDS,
            )
            if (added !== 1) throw new Error('Room expired during admission')
            return prepared
          })
          .catch(async (error: unknown) => {
            if (!prepared) throw error
            const pending = prepared
            // A lost COMMIT acknowledgement does not prove rollback. Reacquire
            // the room lock first: the original transaction must have finished
            // before we inspect its outcome or remove its live membership.
            try {
              const committed = await db.transaction(async (tx) => {
                await tx
                  .select({ id: gameSessions.id })
                  .from(gameSessions)
                  .where(eq(gameSessions.id, pending.session.id))
                  .for('update')
                await reconcileAdmissions(tx, code)
                const [row] = await tx
                  .select({ id: gamePlayers.id })
                  .from(gamePlayers)
                  .where(eq(gamePlayers.id, pending.player.id))
                return Boolean(row)
              })
              if (committed) return pending
            } catch (recoveryError) {
              // A durable pending ID lets the next admission finish recovery
              // if a backing store remains unavailable. Never guess rollback.
              apiLogger.error(
                { err: recoveryError, roomCode: code, playerId: pending.player.id },
                'admission outcome pending reconciliation',
              )
            }
            throw error
          })
        if (admission instanceof Response) return admission
        const { session, player, role, status, gamePlayer, token } = admission
        await engine.touchSessionActivity(code)
        await state.publishEvent(code, { type: 'player_joined', player: gamePlayer })
        // Vacant rooms have no host; the next participating human takes over.
        if (
          (await redis.hget(KEYS.game(code), 'hostSuccessionPending')) ||
          (role === 'player' && !(await state.getHostId(code)))
        )
          await engine.migrateHost(code)

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
