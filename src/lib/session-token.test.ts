import { describe, it, expect, beforeAll } from 'vitest'
import { signSessionToken, verifySessionToken } from './session-token'

beforeAll(() => {
  process.env['SESSION_SECRET'] = 'test-secret-min-32-chars-long-enough!'
})

describe('session-token', () => {
  it('roundtrips player+room', async () => {
    const token = await signSessionToken({ playerId: 'p1', roomCode: 'B7K9MV' })
    const payload = await verifySessionToken(token)
    expect(payload).toMatchObject({ playerId: 'p1', roomCode: 'B7K9MV' })
  })

  it('rejects a tampered token', async () => {
    const token = await signSessionToken({ playerId: 'p1', roomCode: 'B7K9MV' })
    const tampered = token.slice(0, -2) + 'AA'
    await expect(verifySessionToken(tampered)).rejects.toThrow()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signSessionToken({ playerId: 'p1', roomCode: 'B7K9MV' })
    process.env['SESSION_SECRET'] = 'different-secret-min-32-chars-long!!'
    await expect(verifySessionToken(token)).rejects.toThrow()
    process.env['SESSION_SECRET'] = 'test-secret-min-32-chars-long-enough!'
  })
})
