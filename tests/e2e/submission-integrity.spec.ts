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
    async outcome(commandId: string) {
      await expect
        .poll(() => events.find((event) => 'commandId' in event && event.commandId === commandId))
        .toBeTruthy()
      return events.find((event) => 'commandId' in event && event.commandId === commandId)!
    },
    async snapshot() {
      return requestStateSnapshot(ws, events)
    },
  }
  peer.send({ type: 'auth', sessionToken: member.sessionToken })
  await peer.wait('auth_ok')
  return peer
}

async function game(rules: RuleId[] = []) {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'SubmitHost',
    anonId: 'submit-host',
    config: { maxPlayers: 10, roundsToWin: 5, timer: 'Off', packs: [pack.id], rules },
  })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const members = [host, await join(host.roomCode, 'Second'), await join(host.roomCode, 'Third')]
  const peers = await Promise.all(members.map(connect))
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  await Promise.all(peers.map((peer) => peer.wait('round_started')))
  const snapshots = await Promise.all(peers.map((peer) => peer.snapshot()))
  const czar = peers.find((peer) => peer.member.playerId === snapshots[0]!.czarId)!
  const players = peers.filter((peer) => peer !== czar)
  return { host, peers, czar, players }
}

test('foreign card submission is rejected without changing hand or progress', async () => {
  const { peers, players } = await game()
  try {
    const actor = players[0]!
    const before = await actor.snapshot()
    const foreign = (await players[1]!.snapshot()).hand![0]!
    const cardIds = [
      foreign.id,
      ...before.hand!.slice(1, before.prompt.pick).map((card) => card.id),
    ]
    actor.send({ type: 'play', cardIds, commandId: 'foreign' })
    expect(await actor.outcome('foreign')).toMatchObject({ type: 'error', code: 'invalid_state' })
    const after = await actor.snapshot()
    expect(after.hand).toEqual(before.hand)
    expect(after.submitted).toBe(0)
    expect(after.mySubmissionCount).toBe(0)
    actor.send({ type: 'play', cardIds: ['nonexistent-card'], commandId: 'unknown' })
    expect(await actor.outcome('unknown')).toMatchObject({ type: 'error', code: 'invalid_state' })
    expect((await actor.snapshot()).hand).toEqual(before.hand)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('a picking room created before round metadata was introduced still accepts legal submissions', async () => {
  const { peers, players, czar, host } = await game()
  const { default: Redis } = await import('ioredis')
  const redis = new Redis(process.env['REDIS_URL']!)
  try {
    // Recreate the persisted format from the previous release. All
    // assertions use the public protocol, including Czar authorization.
    await redis.hdel(`game:${host.roomCode}:round`, 'roundId', 'czarId')
    await redis.hset(`game:${host.roomCode}`, 'status', 'lobby')
    const judge = await czar.snapshot()
    czar.send({
      type: 'play',
      cardIds: judge.hand!.slice(0, judge.prompt.pick).map((card) => card.id),
      commandId: 'legacy-czar',
    })
    expect(await czar.outcome('legacy-czar')).toMatchObject({
      type: 'error',
      code: 'not_authorized',
    })
    for (const [index, actor] of players.entries()) {
      const before = await actor.snapshot()
      const ids = before.hand!.slice(0, before.prompt.pick).map((card) => card.id)
      actor.send({ type: 'play', cardIds: ids, commandId: `legacy-${index}` })
      expect(await actor.outcome(`legacy-${index}`)).toMatchObject({ type: 'command_accepted' })
      expect((await actor.snapshot()).hand!.map((card) => card.id)).toEqual(
        before.hand!.filter((card) => !ids.includes(card.id)).map((card) => card.id),
      )
    }
    await expect
      .poll(async () => (await czar.snapshot()).phase, { timeout: 15_000 })
      .toBe('judging')
    expect((await czar.snapshot()).submissions).toHaveLength(2)
  } finally {
    redis.disconnect()
    peers.forEach((peer) => peer.ws.close())
  }
})

test('czar, queued player and spectator cannot submit, and late play cannot change the round', async () => {
  const { peers, players, czar, host } = await game()
  try {
    const spectator = await connect(await join(host.roomCode, 'Observer', 'spectator'))
    const queued = await connect(await join(host.roomCode, 'Queued'))
    peers.push(spectator, queued)
    const czarBefore = await czar.snapshot()
    const cards = czarBefore.hand!.slice(0, czarBefore.prompt.pick).map((card) => card.id)
    for (const [index, actor] of [czar, queued, spectator].entries()) {
      actor.send({ type: 'play', cardIds: cards, commandId: `ineligible-${index}` })
      expect(await actor.outcome(`ineligible-${index}`)).toMatchObject({
        type: 'error',
        code: actor === spectator ? 'spectator_action' : 'not_authorized',
      })
    }
    expect((await czar.snapshot()).hand).toEqual(czarBefore.hand)
    expect((await czar.snapshot()).submitted).toBe(0)
    for (const player of players) {
      const before = await player.snapshot()
      player.send({
        type: 'play',
        cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
      })
    }
    await expect
      .poll(async () => (await czar.snapshot()).phase, { timeout: 15_000 })
      .toBe('judging')
    const before = await players[0]!.snapshot()
    players[0]!.send({
      type: 'play',
      cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
      commandId: 'late',
    })
    expect(await players[0]!.outcome('late')).toMatchObject({
      type: 'error',
      code: 'invalid_state',
    })
    const after = await players[0]!.snapshot()
    expect(after.hand).toEqual(before.hand)
    expect(after.submissions).toEqual(before.submissions)
    expect(after.submitted).toBe(before.submitted)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('exact distinct card count is required and concurrent submissions consume only one slot', async () => {
  const { peers, players, czar } = await game()
  try {
    const actor = players[0]!
    const before = await actor.snapshot()
    const pick = before.prompt.pick
    const hand = before.hand!
    for (const [index, cardIds] of [
      hand.slice(0, pick + 1).map((card) => card.id),
      Array.from({ length: Math.max(2, pick) }, () => hand[0]!.id),
    ].entries()) {
      actor.send({ type: 'play', cardIds, commandId: `invalid-${index}` })
      expect(await actor.outcome(`invalid-${index}`)).toMatchObject({
        type: 'error',
        code: 'invalid_state',
      })
      expect((await actor.snapshot()).hand).toEqual(hand)
    }
    const candidates = [0, 1, 2].map((index) =>
      hand
        .slice(index * pick, (index + 1) * pick)
        .reverse()
        .map((card) => card.id),
    )
    candidates.forEach((cardIds, index) =>
      actor.send({ type: 'play', cardIds, commandId: `race-${index}` }),
    )
    const outcomes = await Promise.all(candidates.map((_, index) => actor.outcome(`race-${index}`)))
    expect(outcomes.filter((event) => event.type === 'command_accepted')).toHaveLength(1)
    expect(outcomes.filter((event) => event.type === 'error')).toHaveLength(2)
    const accepted = candidates[outcomes.findIndex((event) => event.type === 'command_accepted')]!
    const after = await actor.snapshot()
    expect(after.hand!.map((card) => card.id)).toEqual(
      hand.filter((card) => !accepted.includes(card.id)).map((card) => card.id),
    )
    expect(after.mySubmissionCount).toBe(1)
    expect(after.submitted).toBe(1)
    const other = await players[1]!.snapshot()
    players[1]!.send({ type: 'play', cardIds: other.hand!.slice(0, pick).map((card) => card.id) })
    await expect
      .poll(async () => (await czar.snapshot()).phase, { timeout: 15_000 })
      .toBe('judging')
    const revealed = await czar.snapshot()
    expect(revealed.submissions).toHaveLength(2)
    expect(
      revealed.submissions.some(
        (submission) =>
          JSON.stringify(submission.fills.map((card) => card.id)) === JSON.stringify(accepted),
      ),
    ).toBe(true)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

for (const playsLast of [true, false]) {
  test(`a gambler who plays ${playsLast ? 'last' : 'first'} must fill both slots and retries cannot rewrite either submission`, async () => {
    test.setTimeout(60_000)
    const { peers, czar } = await game()
    try {
      const czarIndex = peers.indexOf(czar)
      const gambler = peers[(czarIndex + 2) % peers.length]!
      const winning = await gambler.snapshot()
      const winningCards = winning.hand!.slice(0, winning.prompt.pick).map((card) => card.id)
      for (const player of peers.filter((peer) => peer !== czar)) {
        const before = await player.snapshot()
        player.send({
          type: 'play',
          cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
        })
      }
      await expect
        .poll(async () => (await czar.snapshot()).phase, { timeout: 15_000 })
        .toBe('judging')
      const submissions = (await czar.snapshot()).submissions
      const winner = submissions.find((submission) => submission.fills[0]?.id === winningCards[0])!
      const next = peers[0]!.events.length
      czar.send({ type: 'pick', submissionId: winner.submissionId })
      await peers[0]!.wait('round_started', next)
      const round = await gambler.snapshot()
      expect(round.round).toBe(2)
      expect(round.czarId).not.toBe(gambler.member.playerId)
      const other = peers.find((peer) => peer !== gambler && peer.member.playerId !== round.czarId)!
      const otherHand = await other.snapshot()
      const otherCards = otherHand.hand!.slice(0, round.prompt.pick).map((card) => card.id)
      if (playsLast) other.send({ type: 'play', cardIds: otherCards })
      const wagerStart = gambler.events.length
      gambler.send({ type: 'gamble' })
      await gambler.wait('hand_update', wagerStart)
      const wager = await gambler.snapshot()
      expect(wager.hand).toHaveLength(10 + round.prompt.pick)
      const primary = wager.hand!.slice(0, round.prompt.pick).map((card) => card.id)
      const second = wager
        .hand!.slice(round.prompt.pick, round.prompt.pick * 2)
        .reverse()
        .map((card) => card.id)
      gambler.send({ type: 'play', cardIds: primary, commandId: 'primary' })
      expect(await gambler.outcome('primary')).toMatchObject({ type: 'command_accepted' })
      const pending = await gambler.snapshot()
      expect(pending.phase).toBe('picking')
      expect(pending.mySubmissionCount).toBe(1)
      expect(pending.submitted).toBe(playsLast ? 1 : 0)
      gambler.send({ type: 'play', cardIds: primary, commandId: 'primary-retry' })
      gambler.send({ type: 'play', cardIds: second, commandId: 'second' })
      gambler.send({
        type: 'play',
        cardIds: second,
        commandId: 'second-retry',
      })
      expect(await gambler.outcome('primary-retry')).toMatchObject({ type: 'error' })
      const secondOutcomes = await Promise.all([
        gambler.outcome('second'),
        gambler.outcome('second-retry'),
      ])
      expect(secondOutcomes.filter((event) => event.type === 'command_accepted')).toHaveLength(1)
      expect(secondOutcomes.filter((event) => event.type === 'error')).toHaveLength(1)
      gambler.send({
        type: 'play',
        cardIds: wager
          .hand!.slice(round.prompt.pick * 2, round.prompt.pick * 3)
          .map((card) => card.id),
        commandId: 'third',
      })
      expect(await gambler.outcome('third')).toMatchObject({ type: 'error' })
      if (!playsLast) other.send({ type: 'play', cardIds: otherCards })
      await expect
        .poll(async () => (await gambler.snapshot()).phase, { timeout: 15_000 })
        .toBe('judging')
      const after = await gambler.snapshot()
      expect(after.mySubmissionCount).toBe(2)
      expect(after.submitted).toBe(2)
      expect(after.hand!.map((card) => card.id)).toEqual(
        wager
          .hand!.filter((card) => ![...primary, ...second].includes(card.id))
          .map((card) => card.id),
      )
      expect(after.submissions).toHaveLength(3)
      for (const ids of [primary, second]) {
        expect(
          after.submissions.some(
            (submission) =>
              JSON.stringify(submission.fills.map((card) => card.id)) === JSON.stringify(ids),
          ),
        ).toBe(true)
      }
    } finally {
      peers.forEach((peer) => peer.ws.close())
    }
  })
}

test('pick-three rejects duplicate and incomplete plays and reveals fills in the submitted order', async () => {
  test.setTimeout(60_000)
  const { peers, players, czar } = await game(['happy_ending'])
  try {
    peers[0]!.send({ type: 'happy_ending' })
    for (const player of players) {
      const before = await player.snapshot()
      player.send({
        type: 'play',
        cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
      })
    }
    await expect
      .poll(async () => (await czar.snapshot()).phase, { timeout: 15_000 })
      .toBe('judging')
    const start = peers[0]!.events.length
    czar.send({ type: 'pick', submissionId: '0' })
    await peers[0]!.wait('round_started', start)
    const round = await peers[0]!.snapshot()
    expect(round.prompt.pick).toBe(3)
    const submitters = peers.filter((peer) => peer.member.playerId !== round.czarId)
    const actor = submitters[0]!
    const before = await actor.snapshot()
    const hand = before.hand!
    for (const [index, cardIds] of [
      [hand[0]!.id, hand[1]!.id],
      [hand[0]!.id, hand[0]!.id, hand[1]!.id],
    ].entries()) {
      actor.send({ type: 'play', cardIds, commandId: `pick-three-invalid-${index}` })
      expect(await actor.outcome(`pick-three-invalid-${index}`)).toMatchObject({
        type: 'error',
        code: 'invalid_state',
      })
      expect((await actor.snapshot()).hand).toEqual(hand)
    }
    const ordered = [hand[2]!, hand[0]!, hand[1]!]
    actor.send({ type: 'play', cardIds: ordered.map((card) => card.id), commandId: 'ordered' })
    expect(await actor.outcome('ordered')).toMatchObject({ type: 'command_accepted' })
    const other = await submitters[1]!.snapshot()
    submitters[1]!.send({ type: 'play', cardIds: other.hand!.slice(0, 3).map((card) => card.id) })
    await expect
      .poll(async () => (await actor.snapshot()).phase, { timeout: 15_000 })
      .toBe('judging')
    expect(
      (await actor.snapshot()).submissions.map((submission) => submission.fills),
    ).toContainEqual(ordered)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})
