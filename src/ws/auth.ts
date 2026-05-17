import { verifySessionToken } from '~/lib/session-token'
import { getPlayer } from '~/lib/game-state'
import type { ErrorCode } from '~/lib/types'

// S2-4: distinguish "dropped player" (grace expired — client must clear
// its session) from "bad/expired token or unknown player" so the handler
// can reply with the right auth_error code.
export type AuthResult =
  | { ok: true; playerId: string; anonId: string }
  | { ok: false; code: ErrorCode }

export async function authenticateSocket(
  code: string,
  message: { type: string; sessionToken?: string; anonId?: string },
): Promise<AuthResult> {
  if (message.type !== 'auth' || !message.sessionToken) return { ok: false, code: 'invalid_token' }
  try {
    const payload = await verifySessionToken(message.sessionToken)
    if (payload.roomCode !== code) return { ok: false, code: 'invalid_token' }
    const player = await getPlayer(code, payload.playerId)
    if (!player) return { ok: false, code: 'invalid_token' }
    if (player.status === 'dropped') return { ok: false, code: 'player_dropped' }
    return { ok: true, playerId: payload.playerId, anonId: message.anonId ?? '' }
  } catch {
    return { ok: false, code: 'invalid_token' }
  }
}
