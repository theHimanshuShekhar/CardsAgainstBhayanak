import { verifySessionToken } from '~/lib/session-token'
import { getPlayer } from '~/lib/game-state'

export async function authenticateSocket(
  code: string,
  message: { type: string; sessionToken?: string; anonId?: string },
): Promise<{ playerId: string; anonId: string } | null> {
  if (message.type !== 'auth' || !message.sessionToken) return null
  try {
    const payload = await verifySessionToken(message.sessionToken)
    if (payload.roomCode !== code) return null
    const player = await getPlayer(code, payload.playerId)
    if (!player || player.status === 'dropped') return null
    return { playerId: payload.playerId, anonId: message.anonId ?? '' }
  } catch {
    return null
  }
}
