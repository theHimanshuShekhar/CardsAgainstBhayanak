import { test, expect } from '@playwright/test'
import Redis from 'ioredis'
import postgres from 'postgres'
import { request as httpRequest } from 'node:http'
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

for (const action of ['config', 'reset'] as const) {
  for (const revoke of ['expiry', 'leave'] as const) {
    test(`HTTP ${action} rejects ${revoke} while its request body is pending`, async () => {
      const { member, config } = await create()
      if (action === 'reset') {
        // Fixture: an ended room keeps its host eligible for Play again.
        const sql = postgres(process.env['DATABASE_URL']!, { max: 1 })
        await sql`update game_sessions set status = 'ended' where code = ${member.roomCode}`
        await sql.end()
      }
      const body = JSON.stringify(
        action === 'config' ? { config: { ...config, roundsToWin: 3 } } : { mode: 'lobby' },
      )
      const pending = httpRequest(`${BASE}/api/games/${member.roomCode}/${action}`, {
        method: action === 'config' ? 'PATCH' : 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${member.sessionToken}`,
          'content-length': Buffer.byteLength(body),
        },
      })
      const response = new Promise<number>((resolve, reject) => {
        pending.once('response', (res) => {
          res.resume()
          resolve(res.statusCode!)
        })
        pending.once('error', reject)
      })
      pending.write(body.slice(0, 1))
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (revoke === 'expiry') {
        const redis = new Redis(process.env['REDIS_URL']!)
        await redis.pexpire(`game:${member.roomCode}`, 1)
        await expect.poll(() => redis.exists(`game:${member.roomCode}`)).toBe(0)
        await redis.quit()
      } else {
        expect((await request(member, 'leave')).status).toBe(204)
      }
      pending.end(body.slice(1))
      expect(await response).toBe(401)
      expect((await request(member, 'config', { config })).status).toBe(401)
    })
  }
}

for (const revoke of ['expiry', 'membership'] as const) {
  test(`pending WebSocket happy ending cannot restore ${revoke}`, async () => {
    const { member, config } = await create()
    const sql = postgres(process.env['DATABASE_URL']!, { max: 2 })
    const redis = new Redis(process.env['REDIS_URL']!)
    // Fixture: arm an active game without needing to play a whole round.
    await sql`update game_sessions set status = 'active', config = ${JSON.stringify({ ...config, rules: ['happy_ending'] })}::jsonb where code = ${member.roomCode}`
    const peer = await connect(member)
    let unlock!: () => void
    let locked!: () => void
    const ready = new Promise<void>((resolve) => {
      locked = resolve
    })
    const release = new Promise<void>((resolve) => {
      unlock = resolve
    })
    let transaction: Promise<unknown> | undefined
    try {
      peer.send({ type: 'auth', sessionToken: member.sessionToken })
      await peer.wait('auth_ok')
      transaction = sql.begin(async (tx) => {
        await tx`lock table game_sessions in access exclusive mode`
        locked()
        await release
      })
      await ready
      peer.send({ type: 'happy_ending' })
      // The command passed participation and is awaiting its SQL lookup.
      await expect
        .poll(async () => {
          const rows =
            await sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
          return rows[0]!.count
        })
        .toBeGreaterThan(0)
      if (revoke === 'expiry') {
        await redis.pexpire(`game:${member.roomCode}`, 1)
        await expect.poll(() => redis.exists(`game:${member.roomCode}`)).toBe(0)
      } else {
        await redis.hdel(`game:${member.roomCode}:players`, member.playerId)
      }
      unlock()
      await transaction
      expect(await peer.wait('error')).toMatchObject({ code: 'invalid_token' })
      expect((await request(member, 'config', { config })).status).toBe(401)
      peer.send({ type: 'ping' })
      expect(await peer.wait('auth_error')).toMatchObject({ code: 'invalid_token' })
    } finally {
      unlock?.()
      await transaction
      peer.ws.close()
      await sql.end()
      await redis.quit()
    }
  })
}

test('a vote delayed by SQL cannot mutate an expired room ballot or outcome', async () => {
  const { member, config } = await create()
  const sql = postgres(process.env['DATABASE_URL']!, { max: 2 })
  const redis = new Redis(process.env['REDIS_URL']!)
  const root = `game:${member.roomCode}`
  const round = `${root}:round`
  // Fixture: a voting round with one voter and another player's response.
  await sql`update game_sessions set status = 'active', config = ${JSON.stringify({ ...config, rules: ['godmode'] })}::jsonb where code = ${member.roomCode}`
  await redis.hset(root, { status: 'active', currentRound: '1' })
  await redis.hset(round, { roundId: 'delayed-vote-round', phase: 'waiting' })
  await redis.set(`${round}:order`, JSON.stringify(['other-player']))
  await redis.hset(
    `${round}:submissions`,
    'other-player',
    JSON.stringify({ submissionId: 'response', fills: [] }),
  )
  const peer = await connect(member)
  let unlock!: () => void
  let locked!: () => void
  const ready = new Promise<void>((resolve) => {
    locked = resolve
  })
  const release = new Promise<void>((resolve) => {
    unlock = resolve
  })
  let transaction: Promise<unknown> | undefined
  try {
    peer.send({ type: 'auth', sessionToken: member.sessionToken })
    await peer.wait('auth_ok')
    transaction = sql.begin(async (tx) => {
      await tx`lock table game_sessions in access exclusive mode`
      locked()
      await release
    })
    await ready
    peer.send({ type: 'vote', submissionId: '0' })
    await expect
      .poll(async () => {
        const rows =
          await sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
        return rows[0]!.count
      })
      .toBeGreaterThan(0)
    await redis.pexpire(root, 1)
    await expect.poll(() => redis.exists(root)).toBe(0)
    unlock()
    await transaction
    await peer.wait('error')
    expect(
      peer.events.some((event) => ['vote_tally', 'round_won', 'round_end'].includes(event.type)),
    ).toBe(false)
    expect(
      await redis.exists(`${round}:voters`, `${round}:voterchoices`, `${round}:votetally`),
    ).toBe(0)
    expect(
      await redis.hmget(
        round,
        'outcomeClaim',
        'completionClaim',
        'winnerId',
        'voteClosed',
        'phase',
      ),
    ).toEqual([null, null, null, null, 'waiting'])
  } finally {
    unlock?.()
    await transaction
    peer.ws.close()
    await sql.end()
    await redis.quit()
  }
})
