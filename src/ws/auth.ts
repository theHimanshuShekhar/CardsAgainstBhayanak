import { authenticateRoomSession } from '~/lib/room-session'
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
    const result = await authenticateRoomSession(message.sessionToken, code)
    return result.ok
      ? { ok: true, playerId: result.playerId, anonId: message.anonId ?? '' }
      : result
  } catch {
    return { ok: false, code: 'invalid_token' }
  }
}
