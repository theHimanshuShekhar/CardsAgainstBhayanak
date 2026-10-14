import { redis, KEYS } from './redis'
import { verifySessionToken } from './session-token'
import type { GamePlayer } from './types'

export type RoomParticipation =
  | { ok: true; player: GamePlayer }
  | { ok: false; code: 'invalid_token' | 'player_dropped' }

// SQL rows preserve history beyond the live room's lifetime. Read room
// existence and membership together so surviving player keys cannot grant access.
export async function getRoomParticipation(
  code: string,
  playerId: string,
): Promise<RoomParticipation> {
  const readPlayer = () =>
    redis.eval(
      `
    if not redis.call('HGET', KEYS[1], 'status') then return nil end
    return redis.call('HGET', KEYS[2], ARGV[1])
    `,
      2,
      KEYS.game(code),
      KEYS.players(code),
      playerId,
    )
  const raw = await readPlayer()
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_token' }
  const player = JSON.parse(raw) as GamePlayer
  if (player.status === 'dropped') return { ok: false, code: 'player_dropped' }
  if (await redis.hget(KEYS.game(code), 'hostSuccessionPending')) {
    const { migrateHost } = await import('./game-engine')
    await migrateHost(code)
    const reconciled = await readPlayer()
    if (typeof reconciled !== 'string') return { ok: false, code: 'invalid_token' }
    const current = JSON.parse(reconciled) as GamePlayer
    if (current.status === 'dropped') return { ok: false, code: 'player_dropped' }
    return { ok: true, player: current }
  }
  return { ok: true, player }
}

export async function authenticateRoomSession(token: string, code: string) {
  let payload
  try {
    payload = await verifySessionToken(token)
  } catch {
    return { ok: false, code: 'invalid_token' } as const
  }
  if (payload.roomCode !== code) return { ok: false, code: 'invalid_token' } as const
  const participation = await getRoomParticipation(payload.roomCode, payload.playerId)
  if (!participation.ok) return participation
  return { ok: true, playerId: payload.playerId, roomCode: payload.roomCode } as const
}
