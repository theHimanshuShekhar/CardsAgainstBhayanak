import { test, expect } from '@playwright/test'
import Redis from 'ioredis'
import type { ClientToServerEvent, ServerToClientEvent } from '../../src/lib/types'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'
type Member = { roomCode: string; playerId: string; sessionToken: string }

async function post(path: string, body: unknown, token?: string) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
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
  const peer = {
    ...member,
    ws,
    events,
    send(event: ClientToServerEvent) {
      ws.send(JSON.stringify(event))
    },
    async wait<T extends ServerToClientEvent['type']>(type: T, after = 0) {
      await expect
        .poll(() => events.slice(after).find((event) => event.type === type), { timeout: 10_000 })
        .toBeTruthy()
      return events.slice(after).find((event) => event.type === type) as Extract<
        ServerToClientEvent,
        { type: T }
      >
    },
  }
  peer.send({ type: 'auth', sessionToken: member.sessionToken })
  await peer.wait('auth_ok')
  return peer
}

// Resource counts are observed through Redis's public administrative protocol.
test('room churn releases subscribers after the final eligible socket', async () => {
  const redis = new Redis(process.env['REDIS_URL']!)
  const sockets: WebSocket[] = []
  const clients = async () => {
    const list = String(await redis.client('LIST'))
    return list.split('\n').filter((line) => new RegExp(`\\bdb=${redis.options.db}\\b`).test(line))
      .length
  }
  const subscribers = async (code: string) => {
    const counts = await redis.pubsub('NUMSUB', `game:${code}:channel`)
    return Number(counts[1])
  }
  try {
    const baseline = await clients()
    const { packs } = await (await fetch(BASE + '/api/packs')).json()
    for (let cycle = 0; cycle < 4; cycle++) {
      const response = await post('/api/games', {
        username: 'ChurnHost',
        anonId: 'churn-host',
        config: { maxPlayers: 3, roundsToWin: 3, timer: 'Off', packs: [packs[0].id], rules: [] },
      })
      expect(response.status).toBe(201)
      const member = (await response.json()) as Member
      expect(await subscribers(member.roomCode)).toBe(0)
      const peers = await Promise.all([connect(member), connect(member)])
      sockets.push(...peers.map((peer) => peer.ws))
      expect(await subscribers(member.roomCode)).toBe(1)
      peers[0]!.ws.close()
      await expect.poll(() => peers[0]!.ws.readyState).toBe(WebSocket.CLOSED)
      expect(await subscribers(member.roomCode)).toBe(1)
      peers[1]!.send({ type: 'rejoin' })
      await peers[1]!.wait('lobby_snapshot')
      // HTTP departure must release every socket bound to this identity.
      expect(
        (await post(`/api/games/${member.roomCode}/leave`, {}, member.sessionToken)).status,
      ).toBe(204)
      await expect.poll(() => subscribers(member.roomCode)).toBe(0)
      await expect.poll(clients).toBe(baseline)
      const invalid = new WebSocket(
        `${BASE.replace(/^http/, 'ws')}/api/games/${member.roomCode}/ws`,
      )
      sockets.push(invalid)
      await new Promise<void>((resolve) =>
        invalid.addEventListener('open', () => resolve(), { once: true }),
      )
      invalid.send(JSON.stringify({ type: 'auth', sessionToken: member.sessionToken }))
      await expect.poll(() => invalid.readyState).toBe(WebSocket.CLOSED)
      expect(await subscribers(member.roomCode)).toBe(0)
      await expect.poll(clients).toBe(baseline)
    }
  } finally {
    sockets.forEach((socket) => socket.close())
    redis.disconnect()
  }
})

test('closing one room preserves isolated delivery and permits reconnecting it', async () => {
  const redis = new Redis(process.env['REDIS_URL']!)
  const sockets: WebSocket[] = []
  const count = async (roomCode: string) =>
    Number((await redis.pubsub('NUMSUB', `game:${roomCode}:channel`))[1])
  try {
    const { packs } = await (await fetch(BASE + '/api/packs')).json()
    const members: Member[] = []
    for (let i = 0; i < 2; i++) {
      const response = await post('/api/games', {
        username: 'IsolatedHost',
        anonId: 'isolated-host',
        config: { maxPlayers: 3, roundsToWin: 3, timer: 'Off', packs: [packs[0].id], rules: [] },
      })
      expect(response.status).toBe(201)
      members.push(await response.json())
    }
    const [first, second] = await Promise.all(members.map(connect))
    sockets.push(first!.ws, second!.ws)
    first!.ws.close()
    await expect.poll(() => count(members[0]!.roomCode)).toBe(0)
    expect(await count(members[1]!.roomCode)).toBe(1)
    const reconnected = await connect(members[0]!)
    sockets.push(reconnected.ws)
    expect(await count(members[0]!.roomCode)).toBe(1)
    for (let i = 0; i < members.length; i++) {
      const response = await post(`/api/games/${members[i]!.roomCode}/join`, {
        username: `Room${i}Guest`,
        anonId: `room-${i}-guest`,
        role: 'spectator',
      })
      expect(response.status).toBe(200)
    }
    await Promise.all([second!.wait('player_joined'), reconnected.wait('player_joined')])
    second!.send({ type: 'ping' })
    reconnected.send({ type: 'ping' })
    await Promise.all([second!.wait('pong'), reconnected.wait('pong')])
    expect(
      reconnected.events
        .filter((event) => event.type === 'player_joined')
        .map((event) => event.player.username),
    ).toEqual(['Room0Guest'])
    expect(
      second!.events
        .filter((event) => event.type === 'player_joined')
        .map((event) => event.player.username),
    ).toEqual(['Room1Guest'])
    reconnected.ws.close()
    second!.ws.close()
    await expect.poll(() => count(members[0]!.roomCode)).toBe(0)
    await expect.poll(() => count(members[1]!.roomCode)).toBe(0)
  } finally {
    sockets.forEach((socket) => socket.close())
    redis.disconnect()
  }
})
