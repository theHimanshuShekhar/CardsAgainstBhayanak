import { authenticateRoomSession } from './room-session'

export async function authenticate(
  request: Request,
  code: string,
): Promise<{ playerId: string; roomCode: string } | null> {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const result = await authenticateRoomSession(token, code)
    return result.ok ? { playerId: result.playerId, roomCode: result.roomCode } : null
  } catch {
    return null
  }
}
