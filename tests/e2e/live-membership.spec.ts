import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect } from '@playwright/test'
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

async function lobby(maxPlayers = 3) {
  const { packs } = await (await fetch(BASE + '/api/packs')).json()
  const pack = packs.find((p: { name: string }) => /base/i.test(p.name)) ?? packs[0]
  const config = { maxPlayers, roundsToWin: 20, timer: 'Off', packs: [pack.id], rules: [] }
  const response = await post('/api/games', { username: 'Host', anonId: 'membership-host', config })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const second = await join(host.roomCode, 'Second')
  const third = await join(host.roomCode, 'Third')
  return { host, second, third, config }
}

test('leaving a full lobby frees a seat and start excludes departed players', async () => {
  const { host, second, third } = await lobby()
  const peer = await connect(host)
  try {
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, third.sessionToken)).status).toBe(
      204,
    )
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      409,
    )
    const replacement = await join(host.roomCode, 'Replacement')
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    await peer.wait('round_started')
    const snapshot = await peer.snapshot()
    expect(snapshot.scores.map((p) => p.playerId).sort()).toEqual(
      [host.playerId, second.playerId, replacement.playerId].sort(),
    )
    expect(snapshot.expected).toBe(2)
    expect(snapshot.hand).toHaveLength(10)
    const fresh = await connect(replacement)
    try {
      expect((await fresh.snapshot()).hand).toHaveLength(10)
    } finally {
      fresh.ws.close()
    }
  } finally {
    peer.ws.close()
  }
})

test('leaving a full live game frees a seat and replacement activates next round', async () => {
  const { host, second, third } = await lobby(4)
  const fourth = await join(host.roomCode, 'Fourth')
  const peers = await Promise.all([host, second, third, fourth].map((member) => connect(member)))
  let replacement: Awaited<ReturnType<typeof connect>> | undefined
  try {
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    await peers[0]!.wait('round_started')
    const before = await peers[0]!.snapshot()
    const departed = peers.find(
      (peer) => peer.playerId !== before.czarId && peer.playerId !== host.playerId,
    )!
    departed.send({ type: 'leave' })
    expect((await peers[0]!.wait('player_left')).playerId).toBe(departed.playerId)
    const member = await join(host.roomCode, 'LiveReplacement')
    replacement = await connect(member)
    expect((await replacement.snapshot()).hand).toBeUndefined()
    const remaining = peers.filter((peer) => peer !== departed)
    for (const peer of remaining) {
      const snapshot = await peer.snapshot()
      if (peer.playerId === snapshot.czarId) continue
      peer.send({
        type: 'play',
        cardIds: snapshot.hand!.slice(0, snapshot.prompt.pick).map((card) => card.id),
      })
    }
    await expect
      .poll(async () => (await peers[0]!.snapshot()).phase, { timeout: 10_000 })
      .toBe('judging')
    const czar = remaining.find((peer) => peer.playerId === before.czarId)!
    czar.send({ type: 'pick', submissionId: '0' })
    expect((await replacement.wait('round_end')).activatedPlayers).toEqual([member.playerId])
    await replacement.wait('round_started')
    const next = await replacement.snapshot()
    expect(next.round).toBe(2)
    expect(next.hand).toHaveLength(10)
    expect(next.expected).toBe(3)
    expect(next.czarId).not.toBe(departed.playerId)
    expect(next.scores.map((player) => player.playerId).sort()).toEqual(
      [...remaining.map((peer) => peer.playerId), member.playerId].sort(),
    )
  } finally {
    for (const peer of [...peers, ...(replacement ? [replacement] : [])]) peer.ws.close()
  }
})

test('lobby capacity changes count live seats after departure and retain grace seats', async () => {
  const { host, second, config } = await lobby(4)
  const fourth = await join(host.roomCode, 'Fourth')
  const disconnected = await connect(second)
  const peer = await connect(host)
  try {
    disconnected.ws.close()
    await expect.poll(() => disconnected.ws.readyState).toBe(WebSocket.CLOSED)
    const patch = () =>
      fetch(`${BASE}/api/games/${host.roomCode}/config`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${host.sessionToken}`,
        },
        body: JSON.stringify({ config: { ...config, maxPlayers: 3 } }),
      })
    expect((await patch()).status).toBe(409)
    expect(
      (
        await post(`/api/games/${host.roomCode}/join`, {
          username: 'Blocked',
          anonId: 'blocked',
          role: 'player',
        })
      ).status,
    ).toBe(423)
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, fourth.sessionToken)).status).toBe(
      204,
    )
    expect((await patch()).status).toBe(204)
    expect(
      (
        await post(`/api/games/${host.roomCode}/join`, {
          username: 'StillBlocked',
          anonId: 'still-blocked',
          role: 'player',
        })
      ).status,
    ).toBe(423)
  } finally {
    disconnected.ws.close()
    peer.ws.close()
  }
})

test('a departed handle can be claimed once with a fresh membership identity', async () => {
  const { host, second, third } = await lobby()
  const peer = await connect(host)
  try {
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, third.sessionToken)).status).toBe(
      204,
    )
    const replacement = await join(host.roomCode, 'Third')
    expect(replacement.playerId).not.toBe(third.playerId)
    const oldPeer = await connect(third, false)
    try {
      oldPeer.send({ type: 'auth', sessionToken: third.sessionToken })
      expect((await oldPeer.wait('auth_error')).code).toBe('player_dropped')
    } finally {
      oldPeer.ws.close()
    }
    expect(
      (
        await post(`/api/games/${host.roomCode}/join`, {
          username: 'Extra',
          anonId: 'extra',
          role: 'player',
        })
      ).status,
    ).toBe(423)
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    await peer.wait('round_started')
    const snapshot = await peer.snapshot()
    expect(snapshot.scores.map((player) => player.playerId).sort()).toEqual(
      [host.playerId, second.playerId, replacement.playerId].sort(),
    )
    expect(snapshot.expected).toBe(2)
  } finally {
    peer.ws.close()
  }
})

test('concurrent claims of a departed handle create exactly one live membership', async () => {
  const { host, third } = await lobby(4)
  const peer = await connect(host)
  try {
    expect((await post(`/api/games/${host.roomCode}/leave`, {}, third.sessionToken)).status).toBe(
      204,
    )
    const attempts = await Promise.all(
      ['claim-a', 'claim-b'].map((anonId) =>
        post(`/api/games/${host.roomCode}/join`, { username: 'Third', anonId, role: 'player' }),
      ),
    )
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409])
    const rejected = attempts.find((response) => response.status === 409)!
    expect(await rejected.json()).toMatchObject({ code: 'duplicate_username' })
    const accepted = await attempts.find((response) => response.status === 200)!.json()
    expect(accepted.playerId).not.toBe(third.playerId)
    const claimant = await connect({ ...accepted, roomCode: host.roomCode })
    try {
      claimant.send({ type: 'rejoin' })
      const snapshot = await claimant.wait('lobby_snapshot')
      expect(
        snapshot.players.filter(
          (player) => player.username === 'Third' && player.status !== 'dropped',
        ),
      ).toEqual([expect.objectContaining({ id: accepted.playerId, score: 0 })])
      expect(snapshot.players.find((player) => player.id === third.playerId)).toMatchObject({
        username: 'Third',
        status: 'dropped',
      })
    } finally {
      claimant.ws.close()
    }
  } finally {
    peer.ws.close()
  }
})
