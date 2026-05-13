import { SignJWT, jwtVerify } from 'jose'

type TokenPayload = {
  playerId: string
  roomCode: string
  issuedAt: number
}

function getSecret(): Uint8Array {
  const secret = process.env['SESSION_SECRET']
  if (!secret) throw new Error('SESSION_SECRET is not set')
  return new TextEncoder().encode(secret)
}

export async function signSessionToken(payload: Omit<TokenPayload, 'issuedAt'>): Promise<string> {
  const issuedAt = Date.now()
  return new SignJWT({ ...payload, issuedAt })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(issuedAt / 1000))
    .sign(getSecret())
}

export async function verifySessionToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] })
  const { playerId, roomCode, issuedAt } = payload as Record<string, unknown>
  if (
    typeof playerId !== 'string' ||
    typeof roomCode !== 'string' ||
    typeof issuedAt !== 'number'
  ) {
    throw new Error('invalid_token')
  }
  return { playerId, roomCode, issuedAt }
}
