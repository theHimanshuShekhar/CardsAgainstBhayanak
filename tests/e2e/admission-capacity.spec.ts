import { test, expect } from '@playwright/test'
import type { ServerToClientEvent } from '../../src/lib/types'

const base = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'

test('distinct handles racing for the last seat receive one session and a room-full rejection', async () => {
  const { packs } = await (await fetch(`${base}/api/packs`)).json()
  const create = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'CapacityHost',
      anonId: 'capacity-host',
      config: {
        maxPlayers: 3,
        roundsToWin: 3,
        timer: 'Off',
        packs: [packs[0].id],
        rules: [],
      },
    }),
  })
  expect(create.status).toBe(201)
  const host = await create.json()
  const join = (username: string) =>
    fetch(`${base}/api/games/${host.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, anonId: username, role: 'player' }),
    })
  expect((await join('SecondSeat')).status).toBe(200)
  const responses = await Promise.all(['LastSeatA', 'LastSeatB', 'LastSeatC'].map(join))
  expect(responses.map((response) => response.status).sort()).toEqual([200, 423, 423])
  const results = await Promise.all(responses.map((response) => response.json()))
  for (const result of results.filter((_, index) => responses[index]!.status === 423)) {
    expect(result).toMatchObject({ code: 'room_full' })
    expect(result.sessionToken).toBeUndefined()
    expect(result.playerId).toBeUndefined()
  }
  const winner = results.find((_, index) => responses[index]!.status === 200)!
  expect(winner).toMatchObject({
    status: 'active',
    gameStatus: 'lobby',
    sessionToken: expect.any(String),
  })
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/games/${host.roomCode}/ws`)
  const events: ServerToClientEvent[] = []
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  try {
    await new Promise<void>((resolve) =>
      ws.addEventListener('open', () => resolve(), { once: true }),
    )
    ws.send(JSON.stringify({ type: 'auth', sessionToken: winner.sessionToken }))
    await expect.poll(() => events.some((event) => event.type === 'auth_ok')).toBe(true)
    ws.send(JSON.stringify({ type: 'rejoin' }))
    await expect.poll(() => events.find((event) => event.type === 'lobby_snapshot')).toBeTruthy()
    const snapshot = events.find((event) => event.type === 'lobby_snapshot')!
    if (snapshot.type !== 'lobby_snapshot') throw new Error('Expected lobby snapshot')
    expect(snapshot.players).toHaveLength(3)
    expect(snapshot.players.map((player) => player.id)).toContain(winner.playerId)
    // Rejected handles can still join as spectators: admission left no reserved historical row.
    for (const [index, response] of responses.entries()) {
      if (response.status !== 423) continue
      const retry = await fetch(`${base}/api/games/${host.roomCode}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: ['LastSeatA', 'LastSeatB', 'LastSeatC'][index],
          anonId: 'retry',
          role: 'spectator',
        }),
      })
      expect(retry.status).toBe(200)
    }
  } finally {
    ws.close()
  }
})

test('capacity reduction and admission use the same current roster', async () => {
  const { packs } = await (await fetch(`${base}/api/packs`)).json()
  const config = { maxPlayers: 4, roundsToWin: 3, timer: 'Off', packs: [packs[0].id], rules: [] }
  const created = await fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ConfigHost', anonId: 'config-host', config }),
  })
  expect(created.status).toBe(201)
  const host = await created.json()
  const join = (username: string) =>
    fetch(`${base}/api/games/${host.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, anonId: username, role: 'player' }),
    })
  expect((await join('ExistingA')).status).toBe(200)
  expect((await join('ExistingB')).status).toBe(200)
  const [edit, admission] = await Promise.all([
    fetch(`${base}/api/games/${host.roomCode}/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${host.sessionToken}` },
      body: JSON.stringify({ config: { ...config, maxPlayers: 3 } }),
    }),
    join('FourthSeat'),
  ])
  expect([
    [204, 423],
    [409, 200],
  ]).toContainEqual([edit.status, admission.status])
  if (admission.status === 423) expect(await admission.json()).toMatchObject({ code: 'room_full' })
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/games/${host.roomCode}/ws`)
  const events: ServerToClientEvent[] = []
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  try {
    await new Promise<void>((resolve) =>
      ws.addEventListener('open', () => resolve(), { once: true }),
    )
    ws.send(JSON.stringify({ type: 'auth', sessionToken: host.sessionToken }))
    await expect.poll(() => events.some((event) => event.type === 'auth_ok')).toBe(true)
    ws.send(JSON.stringify({ type: 'rejoin' }))
    await expect.poll(() => events.find((event) => event.type === 'lobby_snapshot')).toBeTruthy()
    const snapshot = events.find((event) => event.type === 'lobby_snapshot')!
    if (snapshot.type !== 'lobby_snapshot') throw new Error('Expected lobby snapshot')
    expect(snapshot.config.maxPlayers).toBe(edit.status === 204 ? 3 : 4)
    expect(snapshot.players).toHaveLength(admission.status === 200 ? 4 : 3)
  } finally {
    ws.close()
  }
})
