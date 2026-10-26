import { test, expect, type APIRequestContext } from '@playwright/test'

async function createRoom(request: APIRequestContext) {
  const packsResponse = await request.get('/api/packs')
  const { packs } = (await packsResponse.json()) as { packs: { id: string }[] }
  const config = {
    maxPlayers: 6,
    roundsToWin: 5,
    timer: 'Off',
    packs: [packs[0]!.id],
    rules: [],
  }
  const response = await request.post('/api/games', {
    data: { username: 'EnvelopeHost', anonId: 'envelope-host', config },
  })
  expect(response.status()).toBe(201)
  const room = (await response.json()) as { roomCode: string; sessionToken: string }
  return { ...room, config }
}

test('config rejects malformed envelopes with a consistent client error', async ({ request }) => {
  const room = await createRoom(request)
  for (const body of [null, 42, true, 'config', [], {}, { config: null }, { config: {} }]) {
    const response = await request.patch(`/api/games/${room.roomCode}/config`, {
      headers: {
        authorization: `Bearer ${room.sessionToken}`,
        'content-type': 'application/json',
      },
      data: JSON.stringify(body),
    })
    expect.soft(response.status(), JSON.stringify(body)).toBe(400)
    expect.soft(await response.json(), JSON.stringify(body)).toMatchObject({
      error: 'Invalid config',
      code: 'internal_error',
    })
  }

  // Invalid requests leave the room usable for the host's next config update.
  const response = await request.patch(`/api/games/${room.roomCode}/config`, {
    headers: { authorization: `Bearer ${room.sessionToken}` },
    data: { config: { ...room.config, roundsToWin: 9 } },
  })
  expect(response.status()).toBe(204)
})

test('reset rejects malformed envelopes before checking the game state', async ({ request }) => {
  const room = await createRoom(request)
  for (const body of [null, 42, true, 'lobby', [], {}, { mode: null }, { mode: 'unknown' }]) {
    const response = await request.post(`/api/games/${room.roomCode}/reset`, {
      headers: {
        authorization: `Bearer ${room.sessionToken}`,
        'content-type': 'application/json',
      },
      data: JSON.stringify(body),
    })
    expect.soft(response.status(), JSON.stringify(body)).toBe(400)
    expect.soft(await response.json(), JSON.stringify(body)).toEqual({
      error: "mode must be 'rematch' or 'lobby'",
      code: 'internal_error',
    })
  }

  for (const mode of ['rematch', 'lobby']) {
    const response = await request.post(`/api/games/${room.roomCode}/reset`, {
      headers: { authorization: `Bearer ${room.sessionToken}` },
      data: { mode },
    })
    expect(response.status()).toBe(409)
    expect(await response.json()).toEqual({ error: 'Game is not over', code: 'invalid_state' })
  }
})
