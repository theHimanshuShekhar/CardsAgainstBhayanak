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

async function start(rules: RuleId[] = []) {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'RedrawHost',
    anonId: 'redraw-host',
    config: { maxPlayers: 10, roundsToWin: 20, timer: 'Off', packs: [pack.id], rules },
  })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const members = [host]
  for (let i = 1; i < 4; i++) members.push(await join(host.roomCode, `Player${i}`))
  const peers = await Promise.all(members.map(connect))
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  await peers[0]!.wait('round_started')
  const initial = await peers[0]!.snapshot()
  const czar = peers.find((peer) => peer.playerId === initial.czarId)!
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

async function winnerAfterRound(game: Awaited<ReturnType<typeof start>>, winnerOffset = 2) {
  // Choose a winner who can submit again in round 2; the next Czar is
  // the first member after this round's Czar in the stable join order.
  const candidate = game.peers[(game.peers.indexOf(game.czar!) + winnerOffset) % game.peers.length]!
  const candidateCard = (await candidate.snapshot()).hand![0]!.id
  await ready(game)
  const submissionId = (await game.czar!.snapshot()).submissions.find(
    (submission) => submission.fills[0]?.id === candidateCard,
  )!.submissionId
  const after = game.czar!.events.length
  game.czar!.send({ type: 'pick', submissionId })
  const won = await game.czar!.wait('round_won', after)
  const winner = game.peers.find((peer) => peer.playerId === won.winnerId)!
  await expect.poll(async () => (await winner.snapshot()).round, { timeout: 15_000 }).toBe(2)
  const next = await winner.snapshot()
  game.czar = game.peers.find((peer) => peer.playerId === next.czarId)!
  return winner
}

async function rejectRedraw(actor: Peer, code: string) {
  const before = await actor.snapshot()
  const after = actor.events.length
  actor.send({ type: 'redraw' })
  expect(await actor.wait('error', after)).toMatchObject({ code })
  const next = await actor.snapshot()
  expect(next.hand).toEqual(before.hand)
  expect(next.scores).toEqual(before.scores)
  expect(actor.events.slice(after).filter((event) => event.type === 'hand_update')).toHaveLength(0)
}

test('redraw requires Rebooting even when an active player has a point', async () => {
  const game = await start()
  try {
    const winner = await winnerAfterRound(game)
    await rejectRedraw(winner, 'invalid_state')
  } finally {
    game.close()
  }
})

test('redraw in judging rejects without spending the earned point or changing cards', async () => {
  const game = await start(['rebooting'])
  try {
    const winner = await winnerAfterRound(game)
    await ready(game)
    await rejectRedraw(winner, 'invalid_state')
  } finally {
    game.close()
  }
})

test('simultaneous redraws on two sockets spend one point for exactly one replacement hand', async () => {
  const game = await start(['rebooting'])
  try {
    const winner = await winnerAfterRound(game)
    const duplicate = await connect(winner)
    game.peers.push(duplicate)
    const before = await winner.snapshot()
    const others = await Promise.all(
      game.peers
        .filter((peer) => peer !== winner && peer !== duplicate)
        .map((peer) => peer.snapshot()),
    )
    const after = winner.events.length
    for (let index = 0; index < 8; index++)
      (index % 2 ? duplicate : winner).send({ type: 'redraw' })
    await expect
      .poll(() =>
        [...winner.events.slice(after), ...duplicate.events].filter(
          (event) => event.type === 'error',
        ),
      )
      .toHaveLength(7)
    await winner.wait('scores_update', after)
    const next = await winner.snapshot()
    expect(next.scores.find((score) => score.playerId === winner.playerId)?.score).toBe(0)
    expect(next.hand).toHaveLength(10)
    expect(new Set(next.hand!.map((card) => card.id)).size).toBe(10)
    expect(next.hand!.some((card) => before.hand!.some((old) => old.id === card.id))).toBe(false)
    const updates = winner.events.slice(after).filter((event) => event.type === 'hand_update')
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ hand: next.hand })
    expect(await duplicate.snapshot()).toEqual(next)
    expect(
      await Promise.all(
        game.peers
          .filter((peer) => peer !== winner && peer !== duplicate)
          .map(async (peer) => (await peer.snapshot()).hand),
      ),
    ).toEqual(others.map((snapshot) => snapshot.hand))
  } finally {
    game.close()
  }
})

test('redraw costs one point and remains usable during the resolved round transition', async () => {
  const game = await start(['rebooting'])
  try {
    const winner = await winnerAfterRound(game)
    const before = await winner.snapshot()
    const after = winner.events.length
    winner.send({ type: 'redraw' })
    const changed = await winner.wait('hand_update', after)
    expect(changed.hand).toHaveLength(10)
    expect(changed.hand.some((card) => before.hand!.some((old) => old.id === card.id))).toBe(false)
    await winner.wait('scores_update', after)
    expect(
      (await winner.snapshot()).scores.find((score) => score.playerId === winner.playerId)?.score,
    ).toBe(0)
    await rejectRedraw(winner, 'score_too_low')

    // Fire at the public round_won boundary, while the engine is still
    // completing the round's refills. Every winner's score has just been
    // committed and transition is legal for Rebooting.
    const sent = new Set<string>()
    for (const peer of game.peers) {
      peer.ws.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as ServerToClientEvent
        if (
          message.type === 'round_won' &&
          message.winnerId === peer.playerId &&
          !sent.has(peer.playerId)
        ) {
          sent.add(peer.playerId)
          peer.send({ type: 'redraw' })
        }
      })
    }
    const previousHands = new Map(
      await Promise.all(
        game.peers.map(async (peer) => [peer, (await peer.snapshot()).hand!] as const),
      ),
    )
    await ready(game)
    const offsets = new Map(game.peers.map((peer) => [peer, peer.events.length]))
    const roundAfter = offsets.get(game.czar!)!
    game.czar!.send({ type: 'pick', submissionId: '0' })
    const won = await game.czar!.wait('round_won', roundAfter)
    const actor = game.peers.find((peer) => peer.playerId === won.winnerId)!
    const actorAfter = offsets.get(actor)!
    await actor.wait('scores_update', actorAfter)
    await expect.poll(async () => (await actor.snapshot()).round).toBe(3)
    const next = await actor.snapshot()
    expect(next.scores.find((score) => score.playerId === actor.playerId)?.score).toBe(0)
    expect(next.hand).toHaveLength(10)
    expect(
      next.hand!.some((card) => previousHands.get(actor)!.some((old) => old.id === card.id)),
    ).toBe(false)
    expect(new Set(next.hand!.map((card) => card.id)).size).toBe(10)
    expect(actor.events.slice(actorAfter).filter((event) => event.type === 'error')).toHaveLength(0)
    const handUpdates = actor.events
      .slice(actorAfter)
      .filter((event) => event.type === 'hand_update')
    expect(handUpdates.at(-1)).toMatchObject({ hand: next.hand })
  } finally {
    game.close()
  }
})

test('queued players and spectators cannot redraw or change active players hands', async () => {
  const game = await start(['rebooting'])
  try {
    const queued = await connect(await join(game.host.roomCode, 'Queued'))
    const spectator = await connect(await join(game.host.roomCode, 'Observer', 'spectator'))
    game.peers.push(queued, spectator)
    await rejectRedraw(queued, 'not_authorized')
    await rejectRedraw(spectator, 'spectator_action')
    await rejectRedraw(game.peers[0]!, 'score_too_low')
  } finally {
    game.close()
  }
})

test('redraw at resolution preserves both the prior point and the new round award', async () => {
  const game = await start(['rebooting'])
  try {
    const actor = await winnerAfterRound(game)
    const submittedCard = (await actor.snapshot()).hand![0]!.id
    await ready(game)
    const target = (await game.czar!.snapshot()).submissions.find(
      (submission) => submission.fills[0]?.id === submittedCard,
    )!
    const after = actor.events.length
    game.czar!.send({ type: 'pick', submissionId: target.submissionId })
    await expect
      .poll(async () => (await actor.snapshot()).phase, { intervals: [1, 5, 10] })
      .toBe('transition')
    actor.send({ type: 'redraw' })
    await actor.wait('scores_update', after)
    await expect.poll(async () => (await actor.snapshot()).round, { timeout: 15_000 }).toBe(3)
    expect(
      (await actor.snapshot()).scores.find((score) => score.playerId === actor.playerId)?.score,
    ).toBe(1)
  } finally {
    game.close()
  }
})

test('a redraw racing Czar departure keeps the replacement hand and returns only submitted cards', async () => {
  const game = await start(['rebooting'])
  try {
    const actor = await winnerAfterRound(game)
    const before = await actor.snapshot()
    const submittedIds = before.hand!.slice(0, before.prompt.pick).map((card) => card.id)
    actor.send({ type: 'play', cardIds: submittedIds })
    await actor.wait('command_accepted')
    const after = actor.events.length
    game.czar!.send({ type: 'leave' })
    actor.send({ type: 'redraw' })
    await actor.wait('scores_update', after)
    await expect.poll(async () => (await actor.snapshot()).round, { timeout: 15_000 }).toBe(3)
    const next = await actor.snapshot()
    expect(next.scores.find((score) => score.playerId === actor.playerId)?.score).toBe(0)
    expect(next.hand!.length).toBeGreaterThanOrEqual(10)
    expect(next.hand!.length).toBeLessThanOrEqual(10 + before.prompt.pick)
    expect(
      next.hand!.some((card) =>
        before.hand!.some((old) => old.id === card.id && !submittedIds.includes(old.id)),
      ),
    ).toBe(false)
    expect(new Set(next.hand!.map((card) => card.id)).size).toBe(next.hand!.length)
  } finally {
    game.close()
  }
})

test('a redraw during low-deck round completion still yields a full unique hand', async () => {
  const game = await start(['rebooting'])
  const { default: Redis } = await import('ioredis')
  const { default: postgres } = await import('postgres')
  const fixtureRedis = new Redis(process.env['REDIS_URL']!)
  const fixtureDb = postgres(process.env['DATABASE_URL']!)
  try {
    const actor = await winnerAfterRound(game)
    const snapshots = await Promise.all(game.peers.map((peer) => peer.snapshot()))
    const held = snapshots.flatMap((snapshot) => snapshot.hand!.map((card) => card.id))
    const available = await fixtureDb<
      { id: string }[]
    >`SELECT id FROM white_cards WHERE id NOT IN ${fixtureDb(held)} ORDER BY id LIMIT 80`
    // Prepare an almost depleted deck and a real discard pile. All
    // observations remain at the WebSocket boundary.
    await fixtureRedis
      .multi()
      .del(`game:${game.host.roomCode}:deck:white`, `game:${game.host.roomCode}:discard:white`)
      .rpush(
        `game:${game.host.roomCode}:deck:white`,
        ...available.slice(0, 10).map((card) => card.id),
      )
      .rpush(
        `game:${game.host.roomCode}:discard:white`,
        ...available.slice(10).map((card) => card.id),
      )
      .exec()
    await ready(game)
    const after = actor.events.length
    game.czar!.send({ type: 'pick', submissionId: '0' })
    await expect
      .poll(async () => (await actor.snapshot()).phase, { intervals: [1, 5, 10] })
      .toBe('transition')
    actor.send({ type: 'redraw' })
    await actor.wait('scores_update', after)
    await expect.poll(async () => (await actor.snapshot()).round, { timeout: 15_000 }).toBe(3)
    const next = await actor.snapshot()
    expect(next.hand).toHaveLength(10)
    expect(new Set(next.hand!.map((card) => card.id)).size).toBe(10)
    expect(
      next.hand!.every(
        (card) => available.some((candidate) => candidate.id === card.id) || held.includes(card.id),
      ),
    ).toBe(true)
    const updates = actor.events.slice(after).filter((event) => event.type === 'hand_update')
    expect(updates.at(-1)).toMatchObject({ hand: next.hand })
  } finally {
    fixtureRedis.disconnect()
    await fixtureDb.end()
    game.close()
  }
})

test('Packing Heat racing a redraw appends to the replacement hand without restoring old cards', async () => {
  const game = await start(['rebooting', 'packing_heat'])
  const { default: Redis } = await import('ioredis')
  const { default: postgres } = await import('postgres')
  const fixtureRedis = new Redis(process.env['REDIS_URL']!)
  const fixtureDb = postgres(process.env['DATABASE_URL']!)
  try {
    const actor = await winnerAfterRound(game, 3)
    const before = await actor.snapshot()
    const [prompt] = await fixtureDb<
      { id: string }[]
    >`SELECT id FROM black_cards WHERE pick = 2 AND pack_id = ${before.config.packs[0]!} ORDER BY id LIMIT 1`
    expect(prompt).toBeTruthy()
    await fixtureRedis
      .multi()
      .lrem(`game:${game.host.roomCode}:deck:black`, 0, prompt!.id)
      .lpush(`game:${game.host.roomCode}:deck:black`, prompt!.id)
      .exec()
    actor.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerToClientEvent
      if (message.type === 'round_started' && message.round === 3) actor.send({ type: 'redraw' })
    })
    await ready(game)
    const after = actor.events.length
    game.czar!.send({ type: 'pick', submissionId: '0' })
    const won = await actor.wait('round_won', after)
    await actor.wait('scores_update', after)
    const next = await actor.snapshot()
    expect(next.round).toBe(3)
    expect(next.prompt.pick).toBe(2)
    expect(next.czarId).not.toBe(actor.playerId)
    expect(next.scores.find((score) => score.playerId === actor.playerId)?.score).toBe(
      won.scores.find((score) => score.playerId === actor.playerId)!.score - 1,
    )
    expect([10, 11]).toContain(next.hand!.length)
    expect(new Set(next.hand!.map((card) => card.id)).size).toBe(next.hand!.length)
    expect(next.hand!.some((card) => before.hand!.some((old) => old.id === card.id))).toBe(false)
    const updates = actor.events.slice(after).filter((event) => event.type === 'hand_update')
    expect(updates.at(-1)).toMatchObject({ hand: next.hand })
  } finally {
    fixtureRedis.disconnect()
    await fixtureDb.end()
    game.close()
  }
})
