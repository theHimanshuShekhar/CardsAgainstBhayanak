import { requestStateSnapshot } from '../ws-snapshot'
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

async function join(roomCode: string, username: string, role: 'player' | 'spectator' = 'player') {
  const response = await post(`/api/games/${roomCode}/join`, { username, role, anonId: username })
  expect(response.status).toBe(200)
  return { ...(await response.json()), roomCode } as Member
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
    ws,
    member,
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
    async snapshot() {
      return requestStateSnapshot(ws, events)
    },
  }
  peer.send({ type: 'auth', sessionToken: member.sessionToken })
  await peer.wait('auth_ok')
  return peer
}

async function game(rules: RuleId[] = ['never_have_i_ever']) {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'ConfessionHost',
    anonId: 'confession-host',
    config: { maxPlayers: 10, roundsToWin: 5, timer: 'Off', packs: [pack.id], rules },
  })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const members = [host]
  for (let index = 1; index < 3; index++) members.push(await join(host.roomCode, `Player${index}`))
  const peers = await Promise.all(members.map(connect))
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  await Promise.all(peers.map((peer) => peer.wait('round_started')))
  const snapshots = await Promise.all(peers.map((peer) => peer.snapshot()))
  const czar = peers.find((peer) => peer.member.playerId === snapshots[0]!.czarId)!
  const players = peers.filter((peer) => peer !== czar)
  return { host, peers, czar, players }
}

test('foreign and fabricated confession cards are rejected without changing anyone’s hand', async () => {
  const { host, peers, players } = await game(['never_have_i_ever'])
  let fixture: Awaited<ReturnType<typeof deckFixture>> | undefined
  try {
    const actor = players[0]!
    const other = players[1]!
    const before = await actor.snapshot()
    const foreign = await other.snapshot()
    const hands = await Promise.all(peers.map((peer) => peer.snapshot()))
    fixture = await deckFixture(
      host.roomCode,
      hands.flatMap((state) => state.hand!.map((card) => card.id)),
    )
    for (const cardId of [foreign.hand![0]!.id, 'fabricated-card']) {
      const start = actor.events.length
      actor.send({ type: 'confess_discard', cardId })
      expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
      const after = await actor.snapshot()
      expect(after.hand).toEqual(before.hand)
      expect(after.myDiscardsUsed).toBe(0)
      expect((await other.snapshot()).hand).toEqual(foreign.hand)
      expect(
        actor.events.slice(start).filter((event) => event.type === 'hand_update'),
      ).toHaveLength(0)
    }
    const legalStart = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    const legal = await actor.wait('hand_update', legalStart)
    expect(legal.hand[9]!.id).toBe(fixture.ids[0])
    expect(legal.discardsUsed).toBe(1)
  } finally {
    await fixture?.redis.quit()
    peers.forEach((peer) => peer.ws.close())
  }
})

// These storage fixtures model recovery/state races. All behavior assertions
// use the authenticated protocol, including which card the deck delivers next.
async function deckFixture(roomCode: string, excluded: string[], size = 4) {
  const { default: Redis } = await import('ioredis')
  const { default: postgres } = await import('postgres')
  const redis = new Redis(process.env['REDIS_URL']!)
  const sql = postgres(process.env['DATABASE_URL']!)
  const cards = await sql<
    { id: string }[]
  >`SELECT id FROM white_cards WHERE id NOT IN ${sql(excluded)} ORDER BY id LIMIT ${size}`
  await sql.end()
  const ids = cards.map((card) => card.id)
  await redis.del(`game:${roomCode}:deck:white`)
  if (ids.length) await redis.rpush(`game:${roomCode}:deck:white`, ...ids)
  return { redis, ids }
}

for (const sameCard of [false, true]) {
  test(`concurrent final-allowance discards of ${sameCard ? 'the same card' : 'different cards'} replace exactly one card`, async () => {
    const { host, peers, players } = await game()
    let fixture: Awaited<ReturnType<typeof deckFixture>> | undefined
    try {
      const actor = players[0]!
      const other = players[1]!
      const duplicate = await connect(actor.member)
      peers.push(duplicate)
      for (let count = 0; count < 2; count++) {
        const before = await actor.snapshot()
        const start = actor.events.length
        actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
        expect(await actor.wait('hand_update', start)).toMatchObject({ discardsUsed: count + 1 })
      }
      const before = await actor.snapshot()
      const allHands = await Promise.all(peers.map((peer) => peer.snapshot()))
      fixture = await deckFixture(
        host.roomCode,
        allHands.flatMap((state) => state.hand!.map((card) => card.id)),
      )
      const targets = [before.hand![0]!.id, before.hand![sameCard ? 0 : 1]!.id]
      const start = actor.events.length
      const duplicateStart = duplicate.events.length
      actor.send({ type: 'confess_discard', cardId: targets[0]! })
      duplicate.send({ type: 'confess_discard', cardId: targets[1]! })
      await expect
        .poll(() =>
          [...actor.events.slice(start), ...duplicate.events.slice(duplicateStart)].filter(
            (event) => event.type === 'error',
          ),
        )
        .toHaveLength(1)
      const after = await actor.snapshot()
      expect(after.myDiscardsUsed).toBe(3)
      expect(after.hand).toHaveLength(10)
      expect(new Set(after.hand!.map((card) => card.id)).size).toBe(10)
      const removed = before.hand!.filter(
        (card) => !after.hand!.some((current) => current.id === card.id),
      )
      expect(removed).toHaveLength(1)
      expect(targets).toContain(removed[0]!.id)
      expect(after.hand!.slice(0, 9)).toEqual(
        before.hand!.filter((card) => card.id !== removed[0]!.id),
      )
      expect(after.hand![9]!.id).toBe(fixture.ids[0])
      expect(
        actor.events.slice(start).filter((event) => event.type === 'hand_update'),
      ).toHaveLength(1)
      const cappedStart = actor.events.length
      actor.send({ type: 'confess_discard', cardId: after.hand![0]!.id })
      expect(await actor.wait('error', cappedStart)).toMatchObject({ code: 'invalid_state' })
      expect((await actor.snapshot()).hand).toEqual(after.hand)
      const otherBefore = await other.snapshot()
      const otherStart = other.events.length
      other.send({ type: 'confess_discard', cardId: otherBefore.hand![0]!.id })
      const next = await other.wait('hand_update', otherStart)
      expect(next.hand[9]!.id).toBe(fixture.ids[1])
      expect(next.hand).toHaveLength(10)
    } finally {
      await fixture?.redis.quit()
      peers.forEach((peer) => peer.ws.close())
    }
  })
}

test('disabled rules reject an owned card without changing hand or allowance', async () => {
  const { peers, players } = await game([])
  try {
    const actor = players[0]!
    const before = await actor.snapshot()
    const start = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    expect((await actor.snapshot()).hand).toEqual(before.hand)
    expect((await actor.snapshot()).myDiscardsUsed).toBe(0)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('only active members in picking or transition can confess, and an empty deck is unchanged', async () => {
  const { host, peers, players } = await game()
  const { default: Redis } = await import('ioredis')
  const redis = new Redis(process.env['REDIS_URL']!)
  try {
    let actor = players[0]!
    const queued = await connect(await join(host.roomCode, 'Queued'))
    const spectator = await connect(await join(host.roomCode, 'Observer', 'spectator'))
    peers.push(queued, spectator)
    const before = await actor.snapshot()
    for (const [peer, code] of [
      [queued, 'not_authorized'],
      [spectator, 'spectator_action'],
    ] as const) {
      const start = peer.events.length
      peer.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
      expect(await peer.wait('error', start)).toMatchObject({ code })
      expect((await peer.snapshot()).hand ?? []).toEqual([])
    }
    const gameKey = `game:${host.roomCode}`
    for (const phase of ['waiting', 'judging', 'ranking', 'eliminating', 'reveal']) {
      await redis.hset(`${gameKey}:round`, 'phase', phase)
      const start = actor.events.length
      actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
      expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
      expect((await actor.snapshot()).hand).toEqual(before.hand)
      expect((await actor.snapshot()).myDiscardsUsed).toBe(0)
    }
    await redis.hset(`${gameKey}:round`, 'phase', 'picking')
    const playerRaw = (await redis.hget(`${gameKey}:players`, actor.member.playerId))!
    await redis.hdel(`${gameKey}:players`, actor.member.playerId)
    const missingStart = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    expect(['player_dropped', 'invalid_token']).toContain(
      (await actor.wait('auth_error', missingStart)).code,
    )
    await expect.poll(() => actor.ws.readyState).toBe(WebSocket.CLOSED)
    await redis.hset(`${gameKey}:players`, actor.member.playerId, playerRaw)
    actor = await connect(actor.member)
    peers.push(actor)
    for (const status of ['queued', 'grace', 'dropped']) {
      await redis.hset(
        `${gameKey}:players`,
        actor.member.playerId,
        JSON.stringify({ ...JSON.parse(playerRaw), status }),
      )
      const start = actor.events.length
      actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
      if (status === 'dropped')
        expect(await actor.wait('auth_error', start)).toMatchObject({ code: 'player_dropped' })
      else expect(await actor.wait('error', start)).toMatchObject({ code: 'not_authorized' })
    }
    await redis.hset(`${gameKey}:players`, actor.member.playerId, playerRaw)
    actor = await connect(actor.member)
    peers.push(actor)
    expect((await actor.snapshot()).hand).toEqual(before.hand)
    expect((await actor.snapshot()).myDiscardsUsed).toBe(0)
    const deck = await redis.lrange(`${gameKey}:deck:white`, 0, -1)
    await redis.del(`${gameKey}:deck:white`)
    const emptyStart = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    expect(await actor.wait('error', emptyStart)).toMatchObject({ code: 'invalid_state' })
    expect((await actor.snapshot()).hand).toEqual(before.hand)
    expect((await actor.snapshot()).myDiscardsUsed).toBe(0)
    await redis.rpush(`${gameKey}:deck:white`, ...deck)
    await redis.hset(`${gameKey}:round`, 'phase', 'transition')
    const transitionStart = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    const replacement = await actor.wait('hand_update', transitionStart)
    expect(replacement.hand).toHaveLength(10)
    expect(replacement.hand.some((card) => card.id === before.hand![0]!.id)).toBe(false)
    expect(replacement.discardsUsed).toBe(1)
  } finally {
    await redis.hset(`game:${host.roomCode}:round`, 'phase', 'picking')
    await redis.quit()
    peers.forEach((peer) => peer.ws.close())
  }
})

test('concurrent successful confessions leave the last private update consistent with rejoin', async () => {
  const { peers, players } = await game()
  try {
    const actor = players[0]!
    const second = await connect(actor.member)
    const third = await connect(actor.member)
    peers.push(second, third)
    const before = await actor.snapshot()
    const start = actor.events.length
    const attempts = [actor, second, third].map((peer, index) => ({
      peer,
      index,
      after: peer.events.length,
    }))
    for (const { peer, index } of attempts)
      peer.send({ type: 'confess_discard', cardId: before.hand![index]!.id })
    await expect
      .poll(() => actor.events.slice(start).filter((event) => event.type === 'hand_update').length)
      .toBeGreaterThanOrEqual(2)
    // Preserve the three-way race, then retry only an explicit work-limit rejection.
    await expect
      .poll(
        () =>
          actor.events.slice(start).filter((event) => event.type === 'hand_update').length +
          attempts.filter(({ peer, after }) =>
            peer.events.slice(after).some((event) => event.type === 'error'),
          ).length,
      )
      .toBe(3)
    for (const { peer, index, after } of attempts) {
      const reply = peer.events.slice(after).find((event) => event.type === 'error')
      if (reply?.type === 'error') {
        expect(reply).toMatchObject({ code: 'rate_limited', retryAfterMs: expect.any(Number) })
        await new Promise((resolve) => setTimeout(resolve, reply.retryAfterMs! + 25))
        peer.send({ type: 'confess_discard', cardId: before.hand![index]!.id })
      }
    }
    await expect
      .poll(() => actor.events.slice(start).filter((event) => event.type === 'hand_update'))
      .toHaveLength(3)
    const after = await actor.snapshot()
    const updates = actor.events.slice(start).filter((event) => event.type === 'hand_update')
    expect(after.myDiscardsUsed).toBe(3)
    expect(after.hand).toHaveLength(10)
    expect(updates.at(-1)).toMatchObject({ hand: after.hand, discardsUsed: 3 })
    const counters = updates.map((event) => event.discardsUsed!)
    expect(counters).toEqual([...counters].sort())
    const other = players[1]!
    expect(other.events.filter((event) => event.type === 'hand_update')).toHaveLength(0)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('persisted session and live room policy both gate confession without consuming the next deck card', async () => {
  const { host, peers, players } = await game()
  const actor = players[0]!
  const before = await actor.snapshot()
  const hands = await Promise.all(peers.map((peer) => peer.snapshot()))
  const fixture = await deckFixture(
    host.roomCode,
    hands.flatMap((state) => state.hand!.map((card) => card.id)),
  )
  const { default: postgres } = await import('postgres')
  const sql = postgres(process.env['DATABASE_URL']!)
  const gameKey = `game:${host.roomCode}`
  const config = (await fixture.redis.hget(gameKey, 'config'))!
  try {
    await sql`UPDATE game_sessions SET status = 'paused' WHERE code = ${host.roomCode}`
    let start = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    await sql`UPDATE game_sessions SET status = 'active' WHERE code = ${host.roomCode}`
    await fixture.redis.hset(gameKey, 'status', 'paused')
    start = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    await fixture.redis.hset(
      gameKey,
      'status',
      'active',
      'config',
      JSON.stringify({ ...JSON.parse(config), rules: [] }),
    )
    start = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    await fixture.redis.hset(gameKey, 'config', config)
    expect((await actor.snapshot()).hand).toEqual(before.hand)
    expect((await actor.snapshot()).myDiscardsUsed).toBe(0)
    start = actor.events.length
    actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    const legal = await actor.wait('hand_update', start)
    expect(legal.hand[9]!.id).toBe(fixture.ids[0])
    expect(legal.discardsUsed).toBe(1)
  } finally {
    await sql`UPDATE game_sessions SET status = 'active' WHERE code = ${host.roomCode}`
    await fixture.redis.hset(gameKey, 'status', 'active', 'config', config)
    await sql.end()
    await fixture.redis.quit()
    peers.forEach((peer) => peer.ws.close())
  }
})

test('a confession racing a play cannot replace a submitted card or restore any consumed cards', async () => {
  const { peers, players } = await game()
  try {
    const actor = players[0]!
    const second = await connect(actor.member)
    peers.push(second)
    const before = await actor.snapshot()
    const played = before.hand!.slice(0, before.prompt.pick).map((card) => card.id)
    const start = actor.events.length
    actor.send({ type: 'play', cardIds: played, commandId: 'racing-play' })
    second.send({ type: 'confess_discard', cardId: played[0]! })
    await expect
      .poll(() =>
        actor.events
          .slice(start)
          .find((event) => 'commandId' in event && event.commandId === 'racing-play'),
      )
      .toBeTruthy()
    await expect
      .poll(() =>
        [...actor.events.slice(start), ...second.events].some(
          (event) => event.type === 'hand_update' || (event.type === 'error' && !event.commandId),
        ),
      )
      .toBe(true)
    const outcome = actor.events
      .slice(start)
      .find((event) => 'commandId' in event && event.commandId === 'racing-play')!
    const after = await actor.snapshot()
    if (outcome.type === 'command_accepted') {
      expect(after.myDiscardsUsed).toBe(0)
      expect(after.mySubmissionCount).toBe(1)
      expect(after.hand).toEqual(before.hand!.filter((card) => !played.includes(card.id)))
    } else {
      expect(after.myDiscardsUsed).toBe(1)
      expect(after.mySubmissionCount).toBe(0)
      expect(after.hand).toHaveLength(10)
      expect(after.hand!.slice(0, 9)).toEqual(before.hand!.slice(1))
    }
    expect(new Set(after.hand!.map((card) => card.id)).size).toBe(after.hand!.length)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('a confession on the round result survives the transition refill and the next round', async () => {
  const { peers, players, czar } = await game()
  try {
    const actor = players[0]!
    const before = await actor.snapshot()
    const discarded = before.hand![before.prompt.pick]!.id
    const winningCard = before.hand![0]!.id
    for (const peer of players) {
      const hand = await peer.snapshot()
      peer.send({
        type: 'play',
        cardIds: hand.hand!.slice(0, hand.prompt.pick).map((card) => card.id),
      })
    }
    await expect
      .poll(async () => (await actor.snapshot()).phase, { timeout: 15_000 })
      .toBe('judging')
    const judging = await actor.snapshot()
    const winning = judging.submissions.find(
      (submission) => submission.fills[0]!.id === winningCard,
    )!
    const start = actor.events.length
    actor.ws.addEventListener('message', (event) => {
      if (JSON.parse(String(event.data)).type === 'round_won')
        actor.send({ type: 'confess_discard', cardId: discarded })
    })
    czar.send({ type: 'pick', submissionId: winning.submissionId })
    await expect
      .poll(() =>
        actor.events
          .slice(start)
          .find((event) => event.type === 'hand_update' && event.discardsUsed === 1),
      )
      .toBeTruthy()
    await actor.wait('round_started', start)
    const after = await actor.snapshot()
    expect(after.round).toBe(2)
    expect(after.myDiscardsUsed).toBe(1)
    expect(after.hand).toHaveLength(10)
    expect(after.hand!.some((card) => card.id === discarded)).toBe(false)
    expect(after.hand!.some((card) => card.id === winningCard)).toBe(false)
    const updates = actor.events.slice(start).filter((event) => event.type === 'hand_update')
    expect(updates.at(-1)).toMatchObject({ hand: after.hand, discardsUsed: 1 })
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})
