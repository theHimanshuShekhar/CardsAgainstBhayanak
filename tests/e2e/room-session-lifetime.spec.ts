import { test, expect } from '@playwright/test'
import Redis from 'ioredis'
import type { ClientToServerEvent, GameConfig, ServerToClientEvent } from '../../src/lib/types'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'
type Member = { roomCode: string; playerId: string; sessionToken: string }

async function request(member: Member, action: string, body: unknown = {}) {
  return fetch(`${BASE}/api/games/${member.roomCode}/${action}`, {
    method: action === 'config' ? 'PATCH' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${member.sessionToken}` },
    body: JSON.stringify(body),
  })
}

async function create() {
  const { packs } = (await (await fetch(`${BASE}/api/packs`)).json()) as {
    packs: { id: string }[]
  }
  const config: GameConfig = {
    maxPlayers: 10,
    roundsToWin: 20,
    timer: 'Off',
    packs: [packs[0]!.id],
    rules: [],
  }
  const response = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'LifetimeHost', anonId: 'lifetime-host', config }),
  })
  expect(response.status).toBe(201)
  return { member: (await response.json()) as Member, config }
}

async function connect(member: Member) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/games/${member.roomCode}/ws`)
  const events: ServerToClientEvent[] = []
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    })
  })
  return {
    ws,
    events,
    send(event: ClientToServerEvent) {
      ws.send(JSON.stringify(event))
    },
    async wait<T extends ServerToClientEvent['type']>(type: T, after = 0) {
      await expect.poll(() => events.slice(after).find((event) => event.type === type)).toBeTruthy()
      return events.slice(after).find((event) => event.type === type) as Extract<
        ServerToClientEvent,
        { type: T }
      >
    },
  }
}

test('room expiry rejects HTTP changes and WebSocket authentication despite retained membership', async () => {
  const { member, config } = await create()
  const redis = new Redis(process.env['REDIS_URL']!)
  // Expire only the live room: player keys and historical SQL rows deliberately survive.
  await redis.pexpire(`game:${member.roomCode}`, 1)
  await expect.poll(() => redis.exists(`game:${member.roomCode}`)).toBe(0)
  await redis.quit()
  const peer = await connect(member)
  try {
    expect(
      (await request(member, 'config', { config: { ...config, roundsToWin: 3 } })).status,
    ).toBe(401)
    peer.send({ type: 'auth', sessionToken: member.sessionToken })
    expect(await peer.wait('auth_error')).toMatchObject({ code: 'invalid_token' })
    await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED)
    expect(peer.events.some((event) => event.type === 'auth_ok')).toBe(false)
  } finally {
    peer.ws.close()
  }
})

for (const command of ['rejoin', 'ping', 'leave'] as const) {
  test(`an authenticated socket rejects ${command} after room expiry`, async () => {
    const { member } = await create()
    const peer = await connect(member)
    try {
      peer.send({ type: 'auth', sessionToken: member.sessionToken })
      await peer.wait('auth_ok')
      const redis = new Redis(process.env['REDIS_URL']!)
      await redis.pexpire(`game:${member.roomCode}`, 1)
      await expect.poll(() => redis.exists(`game:${member.roomCode}`)).toBe(0)
      await redis.quit()

      const after = peer.events.length
      peer.send({ type: command })
      expect(await peer.wait('auth_error', after)).toMatchObject({ code: 'invalid_token' })
      await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED)
      expect(peer.events.slice(after).some((event) => event.type.endsWith('_snapshot'))).toBe(false)
      for (const action of ['start', 'reset', 'leave'])
        expect((await request(member, action, { mode: 'lobby' })).status).toBe(401)
      const join = await fetch(`${BASE}/api/games/${member.roomCode}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: 'ExpiredJoiner',
          anonId: 'expired-joiner',
          role: 'player',
        }),
      })
      expect(join.status).toBe(404)
    } finally {
      peer.ws.close()
    }
  })
}

test('expired live membership rejects HTTP and WebSocket despite retained player history', async () => {
  const { member, config } = await create()
  const redis = new Redis(process.env['REDIS_URL']!)
  await redis.pexpire(`game:${member.roomCode}:players`, 1)
  await expect.poll(() => redis.exists(`game:${member.roomCode}:players`)).toBe(0)
  await redis.quit()
  const peer = await connect(member)
  try {
    expect((await request(member, 'config', { config })).status).toBe(401)
    peer.send({ type: 'auth', sessionToken: member.sessionToken })
    expect(await peer.wait('auth_error')).toMatchObject({ code: 'invalid_token' })
    await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED)
  } finally {
    peer.ws.close()
  }
})

test('an expired lobby with enough retained players cannot be restarted by its old host token', async () => {
  const { member } = await create()
  for (const username of ['LifetimeSecond', 'LifetimeThird']) {
    const joined = await fetch(`${BASE}/api/games/${member.roomCode}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, anonId: username, role: 'player' }),
    })
    expect(joined.status).toBe(200)
  }
  const redis = new Redis(process.env['REDIS_URL']!)
  await redis.pexpire(`game:${member.roomCode}`, 1)
  await expect.poll(() => redis.exists(`game:${member.roomCode}`)).toBe(0)
  await redis.quit()
  expect((await request(member, 'start')).status).toBe(401)
  const joined = await fetch(`${BASE}/api/games/${member.roomCode}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'AfterRestart', anonId: 'after-restart', role: 'player' }),
  })
  expect(joined.status).toBe(404)
})

for (const transport of ['HTTP', 'WebSocket'] as const) {
  test(`${transport} leave revokes the token on both transports`, async () => {
    const { member, config } = await create()
    const peer = await connect(member)
    let reconnect: Awaited<ReturnType<typeof connect>> | undefined
    try {
      peer.send({ type: 'auth', sessionToken: member.sessionToken })
      await peer.wait('auth_ok')
      if (transport === 'HTTP') expect((await request(member, 'leave')).status).toBe(204)
      else peer.send({ type: 'leave' })
      expect(await peer.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
      await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED)
      expect((await request(member, 'config', { config })).status).toBe(401)
      expect((await request(member, 'leave')).status).toBe(401)
      reconnect = await connect(member)
      reconnect.send({ type: 'auth', sessionToken: member.sessionToken })
      expect(await reconnect.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
      await expect.poll(() => reconnect!.ws.readyState).toBe(WebSocket.CLOSED)
    } finally {
      peer.ws.close()
      reconnect?.ws.close()
    }
  })
}

test('a valid session survives disconnect and can mutate over HTTP and reconnect over WebSocket', async () => {
  const { member, config } = await create()
  const peer = await connect(member)
  let reconnect: Awaited<ReturnType<typeof connect>> | undefined
  try {
    peer.send({ type: 'auth', sessionToken: member.sessionToken })
    await peer.wait('auth_ok')
    peer.ws.close()
    await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED)
    const changed = { ...config, roundsToWin: 3 }
    // HTTP must accept a disconnected member in grace without promoting or dropping it.
    expect((await request(member, 'config', { config: changed })).status).toBe(204)
    reconnect = await connect(member)
    reconnect.send({ type: 'auth', sessionToken: member.sessionToken })
    await reconnect.wait('auth_ok')
    reconnect.send({ type: 'rejoin' })
    expect(await reconnect.wait('lobby_snapshot')).toMatchObject({
      config: changed,
      players: [expect.objectContaining({ id: member.playerId, status: 'active' })],
    })
    reconnect.send({ type: 'ping' })
    await reconnect.wait('pong')
    expect((await request(member, 'config', { config })).status).toBe(204)
  } finally {
    peer.ws.close()
    reconnect?.ws.close()
  }
})

test('a valid token cannot operate on another room over HTTP or WebSocket', async () => {
  const original = await create()
  const other = await create()
  const wrongRoom = { ...original.member, roomCode: other.member.roomCode }
  const peer = await connect(wrongRoom)
  try {
    for (const action of ['config', 'start', 'reset', 'leave'])
      expect(
        (await request(wrongRoom, action, { config: other.config, mode: 'lobby' })).status,
      ).toBe(401)
    peer.send({ type: 'auth', sessionToken: original.member.sessionToken })
    expect(await peer.wait('auth_error')).toMatchObject({ code: 'invalid_token' })
    await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED)
    expect((await request(original.member, 'config', { config: original.config })).status).toBe(204)
  } finally {
    peer.ws.close()
  }
})
