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

async function createRoom(): Promise<Member> {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'BroadcastHost',
    anonId: 'broadcast-host',
    config: {
      maxPlayers: 10,
      roundsToWin: 5,
      timer: 'Off',
      packs: [pack.id],
      rules: ['never_have_i_ever'],
    },
  })
  expect(response.status).toBe(201)
  return response.json()
}

async function join(roomCode: string, username: string): Promise<Member> {
  const response = await post(`/api/games/${roomCode}/join`, {
    username,
    anonId: `broadcast-${username}`,
    role: 'player',
  })
  expect(response.status).toBe(200)
  return { ...(await response.json()), roomCode }
}

async function connect(roomCode: string) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/games/${roomCode}/ws`)
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
      await expect
        .poll(() => events.slice(after).find((event) => event.type === type), { timeout: 10_000 })
        .toBeTruthy()
      return events.slice(after).find((event) => event.type === type) as Extract<
        ServerToClientEvent,
        { type: T }
      >
    },
  }
}

test('a pending socket receives roster events only after room authentication', async () => {
  const host = await createRoom()
  const observer = await connect(host.roomCode)
  const pending = await connect(host.roomCode)
  try {
    observer.send({ type: 'auth', sessionToken: host.sessionToken })
    await observer.wait('auth_ok')
    const second = await join(host.roomCode, 'Second')
    expect((await observer.wait('player_joined')).player.id).toBe(second.playerId)
    // Allow the same fanout to reach every socket before checking absence.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(pending.events).toEqual([])

    pending.send({ type: 'auth', sessionToken: second.sessionToken })
    await pending.wait('auth_ok')
    const third = await join(host.roomCode, 'Third')
    expect((await pending.wait('player_joined')).player.id).toBe(third.playerId)
    const disconnected = await connect(host.roomCode)
    disconnected.ws.close()
    await expect.poll(() => disconnected.ws.readyState).toBe(WebSocket.CLOSED)
    pending.send({ type: 'rejoin' })
    expect((await pending.wait('lobby_snapshot')).players.map((player) => player.status)).toEqual([
      'active',
      'active',
      'active',
    ])
  } finally {
    observer.ws.close()
    pending.ws.close()
  }
})

test('pending and rejected sockets receive no round, score or private hand events', async () => {
  test.setTimeout(60_000)
  const host = await createRoom()
  const foreign = await createRoom()
  const pending = await connect(host.roomCode)
  const invalid = await connect(host.roomCode)
  const crossRoom = await connect(host.roomCode)
  const members = [host, await join(host.roomCode, 'Second'), await join(host.roomCode, 'Third')]
  const peers = await Promise.all(members.map(() => connect(host.roomCode)))
  try {
    for (const [index, peer] of peers.entries()) {
      peer.send({ type: 'auth', sessionToken: members[index]!.sessionToken })
      await peer.wait('auth_ok')
    }
    invalid.send({ type: 'auth', sessionToken: 'invalid-token' })
    crossRoom.send({ type: 'auth', sessionToken: foreign.sessionToken })
    for (const rejected of [invalid, crossRoom]) {
      expect(await rejected.wait('auth_error')).toMatchObject({ code: 'invalid_token' })
      await expect.poll(() => rejected.ws.readyState).toBe(WebSocket.CLOSED)
    }

    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    for (const peer of peers) {
      expect((await peer.wait('round_started')).round).toBe(1)
    }
    const snapshots = await Promise.all(
      peers.map(async (peer) => {
        peer.send({ type: 'rejoin' })
        return (await peer.wait('state_snapshot')).state
      }),
    )
    const czarIndex = members.findIndex((member) => member.playerId === snapshots[0]!.czarId)
    const ownerIndex = members.findIndex((_, index) => index !== czarIndex)
    const owner = peers[ownerIndex]!
    const discarded = snapshots[ownerIndex]!.hand![0]!.id
    const handStart = owner.events.length
    owner.send({ type: 'confess_discard', cardId: discarded })
    const hand = (await owner.wait('hand_update', handStart)).hand
    expect(hand).toHaveLength(10)
    expect(hand.map((card) => card.id)).not.toContain(discarded)
    for (const [index, peer] of peers.entries()) {
      if (index === czarIndex) continue
      const cards = index === ownerIndex ? hand : snapshots[index]!.hand!
      peer.send({
        type: 'play',
        cardIds: cards.slice(0, snapshots[index]!.prompt.pick).map((c) => c.id),
      })
    }
    const czar = peers[czarIndex]!
    // Poll the public snapshot until the server completes its reveal animation.
    await expect
      .poll(
        async () => {
          const after = czar.events.length
          czar.send({ type: 'rejoin' })
          return (await czar.wait('state_snapshot', after)).state.phase
        },
        { timeout: 10_000 },
      )
      .toBe('judging')
    czar.send({ type: 'pick', submissionId: '0' })
    for (const peer of peers) {
      expect((await peer.wait('round_won')).scores.some((score) => score.score === 1)).toBe(true)
      expect(Object.keys((await peer.wait('round_end')).handsRefilled)).toHaveLength(2)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(pending.events).toEqual([])
    for (const rejected of [invalid, crossRoom]) {
      expect(rejected.events.map((event) => event.type)).toEqual(['auth_error'])
    }
    for (const [index, peer] of peers.entries()) {
      expect(peer.events.filter((event) => event.type === 'hand_update')).toHaveLength(
        index === ownerIndex ? 1 : 0,
      )
    }
  } finally {
    for (const peer of [...peers, pending, invalid, crossRoom]) peer.ws.close()
  }
})

test('overlapping authentication cannot change the socket room member', async () => {
  const host = await createRoom()
  const second = await join(host.roomCode, 'Second')
  const third = await join(host.roomCode, 'Third')
  const observer = await connect(host.roomCode)
  const contender = await connect(host.roomCode)
  try {
    observer.send({ type: 'auth', sessionToken: host.sessionToken })
    await observer.wait('auth_ok')
    contender.send({ type: 'auth', sessionToken: second.sessionToken })
    contender.send({ type: 'auth', sessionToken: third.sessionToken })
    await contender.wait('auth_ok')
    // Drain the socket through a reply before exercising the bound identity.
    contender.send({ type: 'ping' })
    await contender.wait('pong')
    contender.send({ type: 'leave' })
    expect((await observer.wait('player_left')).playerId).toBe(second.playerId)
  } finally {
    observer.ws.close()
    contender.ws.close()
  }
})
