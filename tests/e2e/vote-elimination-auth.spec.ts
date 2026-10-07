import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect } from '@playwright/test'
import type { ClientToServerEvent, ServerToClientEvent, RuleId } from '../../src/lib/types'

test.setTimeout(60_000)

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
    async snapshot() {
      return requestStateSnapshot(ws, events)
    },
  }
  peer.send({ type: 'auth', sessionToken: member.sessionToken })
  await peer.wait('auth_ok')
  return peer
}
type Peer = Awaited<ReturnType<typeof connect>>

async function join(roomCode: string, username: string, role = 'player'): Promise<Member> {
  const response = await post(`/api/games/${roomCode}/join`, {
    username,
    anonId: `resolution-${username}`,
    role,
  })
  expect(response.status).toBe(200)
  return { ...(await response.json()), roomCode }
}

async function start(rules: RuleId[] = [], roundsToWin = 20, begin = true, playerCount = 4) {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'ResolutionHost',
    anonId: 'resolution-host',
    config: { maxPlayers: 10, roundsToWin, timer: 'Off', packs: [pack.id], rules },
  })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const members = [host]
  for (let i = 1; i < playerCount; i++) members.push(await join(host.roomCode, `Player${i}`))
  const peers = await Promise.all(members.map(connect))
  let czar: Peer | undefined
  if (begin) {
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    await peers[0]!.wait('round_started')
    const initial = await peers[0]!.snapshot()
    czar = peers.find((peer) => peer.playerId === initial.czarId)
  }
  return { host, peers, czar, close: () => peers.forEach((peer) => peer.ws.close()) }
}

async function ready(game: Awaited<ReturnType<typeof start>>) {
  for (const peer of game.peers) {
    if (peer === game.czar) continue
    const snapshot = await peer.snapshot()
    peer.send({
      type: 'play',
      cardIds: snapshot.hand!.slice(0, snapshot.prompt.pick).map((card) => card.id),
      commandId: `play-${peer.playerId}`,
    })
    await peer.wait('command_accepted')
  }
  const config = (await game.peers[0]!.snapshot()).config
  const phase = config.rules.includes('godmode')
    ? 'waiting'
    : config.rules.includes('survival')
      ? 'eliminating'
      : config.rules.includes('serious_business')
        ? 'ranking'
        : 'judging'
  await expect
    .poll(async () => (await game.peers[0]!.snapshot()).phase, { timeout: 30_000 })
    .toBe(phase)
}

test('forged elimination in a normal judging round is rejected and leaves it playable', async () => {
  const game = await start()
  try {
    await ready(game)
    const observer = game.peers[0]!
    const before = await observer.snapshot()
    const marker = observer.events.length
    observer.send({ type: 'eliminate', submissionId: '0' })
    expect(await observer.wait('error', marker)).toMatchObject({ code: 'invalid_state' })
    const after = await observer.snapshot()
    expect(after).toMatchObject({
      round: before.round,
      phase: before.phase,
      submissions: before.submissions,
      scores: before.scores,
    })
    game.czar!.send({ type: 'pick', submissionId: '0' })
    await observer.wait('round_end', marker)
    expect(
      observer.events.slice(marker).filter((event) => event.type === 'round_won'),
    ).toHaveLength(1)
  } finally {
    game.close()
  }
})

test('forged vote without a command ID is rejected outside God Is Dead', async () => {
  const game = await start()
  try {
    await ready(game)
    const observer = game.peers[0]!
    const before = await observer.snapshot()
    const marker = observer.events.length
    observer.send({ type: 'vote', submissionId: '0' })
    expect(await observer.wait('error', marker)).toMatchObject({ code: 'invalid_state' })
    const after = await observer.snapshot()
    expect(after).toMatchObject({
      round: before.round,
      phase: before.phase,
      submissions: before.submissions,
      scores: before.scores,
    })
    expect(after.myVotedSubmissionId).toBeNull()
    game.czar!.send({ type: 'pick', submissionId: '0' })
    await observer.wait('round_end', marker)
  } finally {
    game.close()
  }
})

async function rejected(peer: Peer, event: ClientToServerEvent, code: string) {
  const marker = peer.events.length
  peer.send(event)
  expect(await peer.wait('error', marker)).toMatchObject({ code })
}

async function unchanged(observer: Peer, before: Awaited<ReturnType<Peer['snapshot']>>) {
  const after = await observer.snapshot()
  expect(after).toMatchObject({
    round: before.round,
    phase: before.phase,
    submissions: before.submissions,
    scores: before.scores,
  })
  expect(after.eliminationTurnPlayerId).toEqual(before.eliminationTurnPlayerId)
  expect(after.voteTally).toEqual(before.voteTally)
}

test('God Is Dead rejects premature, queued, spectator, departed and self votes before legal voting resolves', async () => {
  const game = await start(['godmode'])
  const extra: Peer[] = []
  try {
    const observer = game.peers[0]!
    await rejected(observer, { type: 'vote', submissionId: '0' }, 'invalid_state')
    const original = await Promise.all(game.peers.map((peer) => peer.snapshot()))
    await ready(game)
    const queued = await connect(await join(game.host.roomCode, 'Queued'))
    const spectator = await connect(await join(game.host.roomCode, 'Spectator', 'spectator'))
    const departed = await connect(await join(game.host.roomCode, 'Departed'))
    extra.push(queued, spectator, departed)
    expect(
      (await post(`/api/games/${game.host.roomCode}/leave`, {}, departed.sessionToken)).status,
    ).toBe(204)
    const before = await observer.snapshot()
    expect(await departed.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
    await expect.poll(() => departed.ws.readyState).toBe(WebSocket.CLOSED)
    await unchanged(observer, before)
    for (const [peer, code] of [
      [queued, 'not_authorized'],
      [spectator, 'spectator_action'],
    ] as const) {
      await rejected(
        peer,
        { type: 'vote', submissionId: '0', commandId: `vote-${peer.playerId}` },
        code,
      )
      await unchanged(observer, before)
      expect((await peer.snapshot()).myVotedSubmissionId).toBeNull()
    }
    const ownId = before.submissions.find((sub) =>
      original[0]!.hand!.some((card) => card.id === sub.fills[0]!.id),
    )!.submissionId
    await rejected(observer, { type: 'vote', submissionId: ownId }, 'invalid_state')
    await unchanged(observer, before)
    const owner = game.peers.findIndex((_, index) =>
      original[index]!.hand!.some((card) => card.id === before.submissions[0]!.fills[0]!.id),
    )
    const marker = observer.events.length
    for (const [index, peer] of game.peers.entries()) {
      const commandId = `legal-${index}`
      const after = peer.events.length
      peer.send({ type: 'vote', submissionId: index === owner ? '1' : '0', commandId })
      expect(await peer.wait('command_accepted', after)).toMatchObject({ commandId })
    }
    await observer.wait('round_end', marker)
    expect(
      observer.events.slice(marker).filter((event) => event.type === 'round_won'),
    ).toHaveLength(1)
  } finally {
    game.close()
    extra.forEach((peer) => peer.ws.close())
  }
})

test('Survival rejects missing turns, wrong actors and alternate-mode votes while eligible turns finish', async () => {
  const game = await start(['survival'])
  const extra: Peer[] = []
  try {
    const observer = game.peers[0]!
    await rejected(observer, { type: 'eliminate', submissionId: '0' }, 'invalid_state')
    await ready(game)
    const queued = await connect(await join(game.host.roomCode, 'Queued'))
    const spectator = await connect(await join(game.host.roomCode, 'Spectator', 'spectator'))
    const departed = await connect(await join(game.host.roomCode, 'Departed'))
    extra.push(queued, spectator, departed)
    expect(
      (await post(`/api/games/${game.host.roomCode}/leave`, {}, departed.sessionToken)).status,
    ).toBe(204)
    const before = await observer.snapshot()
    expect(await departed.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
    await expect.poll(() => departed.ws.readyState).toBe(WebSocket.CLOSED)
    await unchanged(observer, before)
    const actor = game.peers.find((peer) => peer.playerId === before.eliminationTurnPlayerId)!
    const other = game.peers.find((peer) => peer !== actor && peer !== game.czar)!
    for (const [peer, code] of [
      [game.czar!, 'not_authorized'],
      [other, 'not_authorized'],
      [queued, 'not_authorized'],
      [spectator, 'spectator_action'],
    ] as const) {
      await rejected(peer, { type: 'eliminate', submissionId: '0' }, code)
      await unchanged(observer, before)
    }
    await rejected(actor, { type: 'vote', submissionId: '0' }, 'invalid_state')
    await unchanged(observer, before)
    await rejected(actor, { type: 'eliminate', submissionId: '99' }, 'invalid_state')
    await unchanged(observer, before)
    const marker = observer.events.length
    actor.send({ type: 'eliminate', submissionId: '0' })
    await observer.wait('card_eliminated', marker)
    await observer.wait('elimination_turn', marker)
    const midway = await observer.snapshot()
    const next = game.peers.find((peer) => peer.playerId === midway.eliminationTurnPlayerId)!
    await rejected(actor, { type: 'eliminate', submissionId: '1' }, 'not_authorized')
    await unchanged(observer, midway)
    await rejected(next, { type: 'eliminate', submissionId: '0' }, 'invalid_state')
    await unchanged(observer, midway)
    next.send({ type: 'eliminate', submissionId: '1' })
    await observer.wait('round_end', marker)
    expect(
      observer.events.slice(marker).filter((event) => event.type === 'round_won'),
    ).toHaveLength(1)
  } finally {
    game.close()
    extra.forEach((peer) => peer.ws.close())
  }
})

for (const mode of ['godmode', 'serious_business'] as const) {
  test(`${mode} rejects alternate-mode resolution commands and remains playable`, async () => {
    const game = await start([mode])
    try {
      const original = await Promise.all(game.peers.map((peer) => peer.snapshot()))
      await ready(game)
      const observer = game.peers[0]!
      const before = await observer.snapshot()
      await rejected(observer, { type: 'eliminate', submissionId: '0' }, 'invalid_state')
      await unchanged(observer, before)
      const marker = observer.events.length
      if (mode === 'serious_business') {
        await rejected(observer, { type: 'vote', submissionId: '0' }, 'invalid_state')
        await unchanged(observer, before)
        game.czar!.send({ type: 'rank', ranking: ['0', '1', '2'] })
      } else {
        const owner = game.peers.findIndex((_, index) =>
          original[index]!.hand!.some((card) => card.id === before.submissions[0]!.fills[0]!.id),
        )
        for (const [index, peer] of game.peers.entries()) {
          peer.send({ type: 'vote', submissionId: index === owner ? '1' : '0' })
        }
      }
      await observer.wait('round_end', marker)
      expect(
        observer.events
          .slice(marker)
          .filter((event) => event.type === (mode === 'godmode' ? 'round_won' : 'round_ranked')),
      ).toHaveLength(1)
    } finally {
      game.close()
    }
  })
}
