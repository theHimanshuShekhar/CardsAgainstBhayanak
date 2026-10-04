import { test, expect } from '@playwright/test'
import type { ClientToServerEvent, ServerToClientEvent, RuleId } from '../../src/lib/types'

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
      const after = events.length
      peer.send({ type: 'rejoin' })
      return (await peer.wait('state_snapshot', after)).state
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
    .poll(async () => (await game.peers[0]!.snapshot()).phase, { timeout: 10_000 })
    .toBe(phase)
}

test('repeated concurrent Serious Business ranking applies one outcome and one refill', async () => {
  const game = await start(['serious_business'])
  try {
    await ready(game)
    const before = await Promise.all(game.peers.map((peer) => peer.snapshot()))
    const markers = game.peers.map((peer) => peer.events.length)
    for (let i = 0; i < 8; i++) game.czar!.send({ type: 'rank', ranking: ['0', '1', '2'] })
    await game.czar!.wait('round_end', markers[game.peers.indexOf(game.czar!)]!)
    await expect.poll(async () => (await game.czar!.snapshot()).round).toBe(2)
    expect((await game.czar!.snapshot()).scores.map((score) => score.score).sort()).toEqual([
      0, 1, 2, 3,
    ])
    const hands: string[] = []
    for (const [i, peer] of game.peers.entries()) {
      const events = peer.events.slice(markers[i])
      expect(events.filter((event) => event.type === 'round_ranked')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'round_end')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'hand_update')).toHaveLength(
        peer === game.czar ? 0 : 1,
      )
      const hand = (await peer.snapshot()).hand!
      expect(hand).toHaveLength(10)
      expect(hand.slice(0, peer === game.czar ? 10 : 10 - before[i]!.prompt.pick)).toEqual(
        before[i]!.hand,
      )
      hands.push(...hand.map((card) => card.id))
    }
    expect(new Set(hands).size).toBe(40)
    const nextRound = await game.peers[0]!.snapshot()
    game.czar = game.peers.find((peer) => peer.playerId === nextRound.czarId)
    await ready(game)
    const second = game.czar!.events.length
    for (let i = 0; i < 8; i++) game.czar!.send({ type: 'rank', ranking: ['0', '1', '2'] })
    await game.czar!.wait('round_end', second)
    await expect.poll(async () => (await game.czar!.snapshot()).round).toBe(3)
    expect(
      (await game.czar!.snapshot()).scores.reduce((total, score) => total + score.score, 0),
    ).toBe(12)
    for (const peer of game.peers) {
      expect(peer.events.filter((event) => event.type === 'round_ranked')).toHaveLength(2)
      expect(peer.events.filter((event) => event.type === 'round_end')).toHaveLength(2)
      expect((await peer.snapshot()).hand).toHaveLength(10)
    }
  } finally {
    game.close()
  }
})

test('competing Survival commands consume one turn and final elimination completes once', async () => {
  const game = await start(['survival'])
  try {
    await ready(game)
    const observer = game.peers[0]!
    const turn = (await observer.snapshot()).eliminationTurnPlayerId!
    const actor = game.peers.find((peer) => peer.playerId === turn)!
    const marker = observer.events.length
    actor.send({ type: 'eliminate', submissionId: '0' })
    actor.send({ type: 'eliminate', submissionId: '1' })
    actor.send({ type: 'eliminate', submissionId: '0' })
    await observer.wait('card_eliminated', marker)
    await observer.wait('elimination_turn', marker)
    const midway = await observer.snapshot()
    expect(midway.phase).toBe('eliminating')
    expect(
      observer.events.slice(marker).filter((event) => event.type === 'card_eliminated'),
    ).toHaveLength(1)
    expect(
      observer.events.slice(marker).filter((event) => event.type === 'round_won'),
    ).toHaveLength(0)
    const next = game.peers.find((peer) => peer.playerId === midway.eliminationTurnPlayerId)!
    const removed = observer.events
      .slice(marker)
      .find((event) => event.type === 'card_eliminated')!.submissionId
    const target = midway.submissions.find(
      (submission) => submission.submissionId !== removed,
    )!.submissionId
    for (let i = 0; i < 8; i++) next.send({ type: 'eliminate', submissionId: target })
    await observer.wait('round_end', marker)
    await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
    expect((await observer.snapshot()).scores.map((score) => score.score).sort()).toEqual([
      0, 0, 0, 1,
    ])
    const cards: string[] = []
    for (const peer of game.peers) {
      expect(peer.events.filter((event) => event.type === 'round_won')).toHaveLength(1)
      expect(peer.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
      const hand = (await peer.snapshot()).hand!
      expect(hand).toHaveLength(10)
      cards.push(...hand.map((card) => card.id))
      expect(peer.events.filter((event) => event.type === 'hand_update')).toHaveLength(
        peer === game.czar ? 0 : 1,
      )
    }
    expect(new Set(cards).size).toBe(40)
  } finally {
    game.close()
  }
})

test('racing tied final votes opens one revote, then competing final votes complete once', async () => {
  const game = await start(['godmode'])
  try {
    const original = await Promise.all(game.peers.map((peer) => peer.snapshot()))
    await ready(game)
    const observer = game.peers[0]!
    const submissions = (await observer.snapshot()).submissions
    const owner = (sid: number) =>
      game.peers.findIndex((_, index) =>
        original[index]!.hand!.some((card) => card.id === submissions[sid]!.fills[0]!.id),
      )
    const owners = [owner(0), owner(1)]
    const others = game.peers.map((_, i) => i).filter((i) => !owners.includes(i))
    const marker = observer.events.length
    const targets = game.peers.map((_, i) => (i === owners[0] || i === others[0] ? '1' : '0'))
    for (const [i, peer] of game.peers.entries())
      peer.send({ type: 'vote', submissionId: targets[i]! })
    await expect
      .poll(
        () =>
          observer.events
            .slice(marker)
            .filter((event) => event.type === 'vote_tally' && Object.keys(event.votes).length === 0)
            .length,
      )
      .toBe(1)
    expect(
      observer.events.slice(marker).filter((event) => event.type === 'round_won'),
    ).toHaveLength(0)
    expect((await observer.snapshot()).phase).toBe('waiting')
    for (const [i, peer] of game.peers.entries()) {
      for (let repeat = 0; repeat < 4; repeat++)
        peer.send({ type: 'vote', submissionId: i === owners[0] ? '1' : '0' })
    }
    await observer.wait('round_end', marker)
    await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
    const outcome = observer.events.find((event) => event.type === 'round_won')!
    expect(outcome.winnerId).toBe(game.peers[owners[0]!]!.playerId)
    expect((await observer.snapshot()).scores.map((score) => score.score).sort()).toEqual([
      0, 0, 0, 1,
    ])
    const cards: string[] = []
    for (const peer of game.peers) {
      expect(peer.events.filter((event) => event.type === 'round_won')).toHaveLength(1)
      expect(peer.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
      expect(peer.events.filter((event) => event.type === 'hand_update')).toHaveLength(1)
      const hand = (await peer.snapshot()).hand!
      expect(hand).toHaveLength(10)
      cards.push(...hand.map((card) => card.id))
    }
    expect(new Set(cards).size).toBe(40)
  } finally {
    game.close()
  }
})

test('Serious Business with two submissions requires two distinct ranks and awards each once', async () => {
  const game = await start(['serious_business'], 20, true, 3)
  try {
    await ready(game)
    for (const ranking of [['0'], ['0', '00']]) {
      const after = game.czar!.events.length
      game.czar!.send({ type: 'rank', ranking })
      expect(await game.czar!.wait('error', after)).toMatchObject({ code: 'invalid_state' })
      expect((await game.czar!.snapshot()).scores.map((score) => score.score)).toEqual([0, 0, 0])
    }
    for (let i = 0; i < 8; i++) game.czar!.send({ type: 'rank', ranking: ['0', '1'] })
    await game.czar!.wait('round_end')
    await expect.poll(async () => (await game.czar!.snapshot()).round).toBe(2)
    const outcome = game.czar!.events.find((event) => event.type === 'round_ranked')!
    expect(Object.values(outcome.scoresDelta).sort()).toEqual([2, 3])
    expect((await game.czar!.snapshot()).scores.map((score) => score.score).sort()).toEqual([
      0, 2, 3,
    ])
    expect(game.czar!.events.filter((event) => event.type === 'round_ranked')).toHaveLength(1)
    expect(game.czar!.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
    for (const peer of game.peers) expect((await peer.snapshot()).hand).toHaveLength(10)
  } finally {
    game.close()
  }
})
