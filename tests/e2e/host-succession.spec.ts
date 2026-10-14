import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect, type Page } from '@playwright/test'
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

async function join(roomCode: string, username: string): Promise<Member> {
  const response = await post(`/api/games/${roomCode}/join`, {
    username,
    anonId: `participation-${username}`,
    role: 'player',
  })
  expect(response.status).toBe(200)
  return { ...(await response.json()), roomCode }
}

async function connect(member: Member, authenticate = true) {
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
    async snapshot() {
      return requestStateSnapshot(ws, events)
    },
  }
  if (authenticate) {
    peer.send({ type: 'auth', sessionToken: member.sessionToken })
    await peer.wait('auth_ok')
  }
  return peer
}

async function lobby(maxPlayers = 3, rules: string[] = []) {
  const { packs } = await (await fetch(BASE + '/api/packs')).json()
  const pack = packs.find((p: { name: string }) => /base/i.test(p.name)) ?? packs[0]
  const config = { maxPlayers, roundsToWin: 20, timer: 'Off', packs: [pack.id], rules }
  const response = await post('/api/games', { username: 'Host', anonId: 'membership-host', config })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const second = await join(host.roomCode, 'Second')
  const third = await join(host.roomCode, 'Third')
  return { host, second, third, config }
}

async function openMember(page: Page, member: Member, username: string, screen = 'lobby') {
  await page.goto('/')
  await page.evaluate(
    ({ member, username }) =>
      localStorage.setItem(
        'cab_session',
        JSON.stringify({
          ...member,
          username,
          role: 'player',
          anonId: `succession-${username}`,
        }),
      ),
    { member, username },
  )
  await page.goto(`/games/${member.roomCode}/${screen}`)
}

test('lobby successor gets host controls immediately and can start after host leaves', async ({
  page,
}) => {
  const { host, second } = await lobby(4)
  await join(host.roomCode, 'Fourth')
  const peer = await connect(second)
  try {
    await openMember(page, second, 'Second')
    await expect(page.getByText('Waiting for host', { exact: false })).toBeVisible()
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, host.sessionToken)).status).toBe(
      204,
    )
    expect(await peer.wait('host_changed')).toMatchObject({ hostId: second.playerId })
    await expect(page.getByRole('button', { name: /Start game/i })).toBeEnabled()
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      401,
    )
    await page.getByRole('button', { name: /Start game/i }).click()
    await expect(page).toHaveURL(new RegExp(`/games/${host.roomCode}/session$`))
    expect((await peer.snapshot()).hostId).toBe(second.playerId)
  } finally {
    peer.ws.close()
  }
})

test('ended successor sees reset controls and can return everyone to lobby', async ({ page }) => {
  const { host, second } = await lobby()
  const peer = await connect(second)
  try {
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    await peer.wait('round_started')
    const { endGame } = await import('../../src/lib/game-engine')
    await endGame(host.roomCode, 'normal', second.playerId)
    await peer.wait('game_over')
    await openMember(page, second, 'Second', 'end')
    await expect(page.getByRole('button', { name: 'Back to lobby' })).toHaveCount(0)
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, host.sessionToken)).status).toBe(
      204,
    )
    expect(await peer.wait('host_changed')).toMatchObject({ hostId: second.playerId })
    await expect(page.getByRole('button', { name: 'Back to lobby' })).toBeEnabled()
    expect(
      (await post(`/api/games/${host.roomCode}/reset`, { mode: 'lobby' }, host.sessionToken))
        .status,
    ).toBe(401)
    // Reload also obtains persisted ownership rather than relying on the event.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Back to lobby' })).toBeEnabled()
    await page.getByRole('button', { name: 'Back to lobby' }).click()
    await expect(page).toHaveURL(new RegExp(`/games/${host.roomCode}/lobby$`))
    await expect(page.getByText('Game options', { exact: true })).toBeVisible()
  } finally {
    peer.ws.close()
  }
})

test('a room with only a spectator clears ownership and the next human becomes host', async () => {
  const { host, second, third } = await lobby()
  const spectatorResponse = await post(`/api/games/${host.roomCode}/join`, {
    username: 'Observer',
    anonId: 'succession-observer',
    role: 'spectator',
  })
  expect(spectatorResponse.status).toBe(200)
  const spectator = await connect({ ...(await spectatorResponse.json()), roomCode: host.roomCode })
  try {
    for (const member of [second, third, host])
      expect(
        (await post(`/api/games/${host.roomCode}/leave`, {}, member.sessionToken)).status,
      ).toBe(204)
    expect(await spectator.wait('host_changed')).toMatchObject({ hostId: null })
    spectator.send({ type: 'rejoin' })
    const roster = await spectator.wait('lobby_snapshot')
    expect(roster.players.some((player) => player.isHost)).toBe(false)
    const ownershipMarker = spectator.events.length
    const successor = await join(host.roomCode, 'ReturningHuman')
    expect(await spectator.wait('host_changed', ownershipMarker)).toMatchObject({
      hostId: successor.playerId,
    })
    const marker = spectator.events.length
    spectator.send({ type: 'rejoin' })
    const updated = await spectator.wait('lobby_snapshot', marker)
    expect(updated.players.find((player) => player.id === successor.playerId)?.isHost).toBe(true)
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      401,
    )
  } finally {
    spectator.ws.close()
  }
})

test('queued humans can inherit an active room ahead of spectators and Rando', async () => {
  const { host, second, third } = await lobby(5, ['rando'])
  const observerResponse = await post(`/api/games/${host.roomCode}/join`, {
    username: 'OlderObserver',
    anonId: 'older-observer',
    role: 'spectator',
  })
  expect(observerResponse.status).toBe(200)
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  const queued = await join(host.roomCode, 'QueuedHuman')
  const peer = await connect(queued)
  try {
    for (const member of [second, third, host])
      expect(
        (await post(`/api/games/${host.roomCode}/leave`, {}, member.sessionToken)).status,
      ).toBe(204)
    expect(await peer.wait('host_changed')).toMatchObject({ hostId: queued.playerId })
    expect((await peer.snapshot()).hostId).toBe(queued.playerId)
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      401,
    )
  } finally {
    peer.ws.close()
  }
})

test('reconnect grace preserves succession eligibility until the player actually drops', async () => {
  const { host, second, third } = await lobby()
  const secondSocket = await connect(second)
  secondSocket.ws.close()
  const observer = await connect(third)
  try {
    await expect
      .poll(async () => {
        const marker = observer.events.length
        observer.send({ type: 'rejoin' })
        const roster = await observer.wait('lobby_snapshot', marker)
        return roster.players.find((player) => player.id === second.playerId)?.connectionStatus
      })
      .toBe('grace')
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, host.sessionToken)).status).toBe(
      204,
    )
    expect(await observer.wait('host_changed')).toMatchObject({ hostId: second.playerId })
    const successor = await connect(second)
    try {
      const marker = successor.events.length
      successor.send({ type: 'rejoin' })
      const roster = await successor.wait('lobby_snapshot', marker)
      expect(roster.players.find((player) => player.id === second.playerId)?.isHost).toBe(true)
    } finally {
      successor.ws.close()
    }
  } finally {
    observer.ws.close()
  }
})

test('overlapping host and successor departures leave the remaining human in charge', async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { host, second, third, config } = await lobby()
    const observer = await connect(third)
    try {
      const leaving = post(`/api/games/${host.roomCode}/leave`, {}, host.sessionToken)
      await observer.wait('player_left')
      await new Promise((resolve) => setTimeout(resolve, attempt))
      const successorLeaving = post(`/api/games/${host.roomCode}/leave`, {}, second.sessionToken)
      expect((await leaving).status).toBe(204)
      expect((await successorLeaving).status).toBe(204)
      const marker = observer.events.length
      observer.send({ type: 'rejoin' })
      const roster = await observer.wait('lobby_snapshot', marker)
      expect(roster.players.filter((player) => player.isHost).map((player) => player.id)).toEqual([
        third.playerId,
      ])
      const configuration = await fetch(`${BASE}/api/games/${host.roomCode}/config`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${third.sessionToken}`,
        },
        body: JSON.stringify({ config }),
      })
      expect(configuration.status).toBe(204)
    } finally {
      observer.ws.close()
    }
  }
})

test('successor actions recover a succession whose SQL commit failed', async () => {
  const { default: postgres } = await import('postgres')
  const database = postgres(process.env['DATABASE_URL']!)
  const { host, second, config } = await lobby()
  await database.unsafe(`CREATE FUNCTION reject_host_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.host_player_id IS DISTINCT FROM NEW.host_player_id THEN
      RAISE EXCEPTION 'injected host commit failure'; END IF; RETURN NEW; END $$`)
  await database.unsafe(`CREATE CONSTRAINT TRIGGER reject_host_commit AFTER UPDATE ON game_sessions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_host_commit()`)
  try {
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, host.sessionToken)).status).toBe(
      500,
    )
  } finally {
    await database.unsafe('DROP TRIGGER reject_host_commit ON game_sessions')
    await database.unsafe('DROP FUNCTION reject_host_commit()')
    await database.end()
  }
  const configured = await fetch(`${BASE}/api/games/${host.roomCode}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${second.sessionToken}` },
    body: JSON.stringify({ config }),
  })
  expect(configured.status).toBe(204)
  const successor = await connect(second)
  try {
    const marker = successor.events.length
    successor.send({ type: 'rejoin' })
    const snapshot = await successor.wait('lobby_snapshot', marker)
    expect(snapshot.players.filter((player) => player.isHost).map((player) => player.id)).toEqual([
      second.playerId,
    ])
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      401,
    )
  } finally {
    successor.ws.close()
  }
})

test('pending succession preserves a committed successor after an uncertain acknowledgement', async () => {
  const { host, second, config } = await lobby()
  expect((await post(`/api/games/${host.roomCode}/leave`, {}, host.sessionToken)).status).toBe(204)
  const { default: Redis } = await import('ioredis')
  const redis = new Redis(process.env['REDIS_URL']!)
  try {
    // Restart fixture: SQL committed its successor, but live publication was
    // unavailable and the room still carries the durable pending intent.
    const room = `game:${host.roomCode}`
    const players = `${room}:players`
    const oldHost = JSON.parse((await redis.hget(players, host.playerId))!)
    const newHost = JSON.parse((await redis.hget(players, second.playerId))!)
    await redis
      .multi()
      .hset(room, 'hostId', host.playerId, 'hostSuccessionPending', '1')
      .hset(
        players,
        host.playerId,
        JSON.stringify({ ...oldHost, isHost: true }),
        second.playerId,
        JSON.stringify({ ...newHost, isHost: false }),
      )
      .exec()
  } finally {
    await redis.quit()
  }
  const configured = await fetch(`${BASE}/api/games/${host.roomCode}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${second.sessionToken}` },
    body: JSON.stringify({ config }),
  })
  expect(configured.status).toBe(204)
  const successor = await connect(second)
  try {
    const marker = successor.events.length
    successor.send({ type: 'rejoin' })
    const snapshot = await successor.wait('lobby_snapshot', marker)
    expect(snapshot.players.filter((player) => player.isHost).map((player) => player.id)).toEqual([
      second.playerId,
    ])
  } finally {
    successor.ws.close()
  }
})

test('configuration membership recheck does not recover succession while holding the room lock', async () => {
  const { default: postgres } = await import('postgres')
  const { default: Redis } = await import('ioredis')
  const database = postgres(process.env['DATABASE_URL']!)
  const redis = new Redis(process.env['REDIS_URL']!)
  const { host, config } = await lobby()
  let editing: Promise<Response> | undefined
  let completed = false
  const controller = new AbortController()
  try {
    await database.begin(async (tx) => {
      await tx`SELECT id FROM game_sessions WHERE code = ${host.roomCode} FOR UPDATE`
      editing = fetch(`${BASE}/api/games/${host.roomCode}/config`, {
        method: 'PATCH',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${host.sessionToken}`,
        },
        body: JSON.stringify({ config }),
      }).finally(() => {
        completed = true
      })
      // Wait for initial auth to finish and the real config request to queue
      // for our scheduling lock. Then simulate an unfinished succession.
      await expect
        .poll(async () => {
          const [row] = await database`SELECT count(*)::int AS blocked FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%game_sessions%' AND pid <> pg_backend_pid()`
          return row!.blocked
        })
        .toBeGreaterThan(0)
      await redis.hset(`game:${host.roomCode}`, 'hostSuccessionPending', '1')
    })
    const deadline = setTimeout(() => controller.abort(), 3000)
    try {
      expect((await editing!).status).toBe(204)
    } finally {
      clearTimeout(deadline)
    }
  } finally {
    if (!completed || controller.signal.aborted) {
      controller.abort()
      // Failure cleanup only: this dedicated database belongs to this test
      // process. Release any nested app transaction so teardown cannot hang.
      await database`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()`
      await editing?.catch(() => {})
    }
    await redis.quit()
    await database.end()
  }
})
