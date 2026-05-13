import { db } from '~/db'
import { gamePlayers } from '~/db/schema'
import { verifySessionToken } from './session-token'
import { eq } from 'drizzle-orm'

export async function authenticate(
  request: Request,
): Promise<{ playerId: string; roomCode: string } | null> {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const payload = await verifySessionToken(token)
    const [player] = await db.select().from(gamePlayers).where(eq(gamePlayers.id, payload.playerId))
    if (!player || player.status === 'dropped') return null
    return { playerId: payload.playerId, roomCode: payload.roomCode }
  } catch {
    return null
  }
}
