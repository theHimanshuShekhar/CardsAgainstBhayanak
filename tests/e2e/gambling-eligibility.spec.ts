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

async function game(rules: RuleId[] = [], count = 3, updatedRules?: RuleId[]) {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'WagerHost',
    anonId: 'submit-host',
    config: { maxPlayers: 10, roundsToWin: 5, timer: 'Off', packs: [pack.id], rules },
  })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  if (updatedRules) {
    const updated = await fetch(`${BASE}/api/games/${host.roomCode}/config`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${host.sessionToken}`,
      },
      body: JSON.stringify({
        config: {
          maxPlayers: 10,
          roundsToWin: 5,
          timer: 'Off',
          packs: [pack.id],
          rules: updatedRules,
        },
      }),
    })
    expect(updated.status).toBe(204)
  }
  const members = [host]
  for (let index = 1; index < count; index++)
    members.push(await join(host.roomCode, `Player${index}`))
  const peers = await Promise.all(members.map(connect))
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  await Promise.all(peers.map((peer) => peer.wait('round_started')))
  const snapshots = await Promise.all(peers.map((peer) => peer.snapshot()))
  const czar = peers.find((peer) => peer.member.playerId === snapshots[0]!.czarId)!
  const players = peers.filter((peer) => peer !== czar)
  return { host, peers, czar, players }
}

test('round one rejects wagers without changing cards or wager eligibility', async () => {
  const { peers, players } = await game()
  try {
    const actor = players[0]!
    const before = await actor.snapshot()
    const start = actor.events.length
    actor.send({ type: 'gamble' })
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    const after = await actor.snapshot()
    expect(after.hand).toEqual(before.hand)
    expect(after.myHasGambled).toBeFalsy()
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

async function secondRound(rules: RuleId[] = [], createdRules?: RuleId[]) {
  const initial = await game(
    createdRules ?? rules,
    rules.includes('serious_business') ? 4 : 3,
    createdRules ? rules : undefined,
  )
  const { peers, czar } = initial
  const actor = peers[(peers.indexOf(czar) + 2) % peers.length]!
  const winningHand = await actor.snapshot()
  const winningCard = winningHand.hand![0]!.id
  for (const player of initial.players) {
    const before = await player.snapshot()
    player.send({
      type: 'play',
      cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
    })
  }
  const phase = rules.includes('godmode')
    ? 'waiting'
    : rules.includes('survival')
      ? 'eliminating'
      : rules.includes('serious_business')
        ? 'ranking'
        : 'judging'
  await expect.poll(async () => (await actor.snapshot()).phase, { timeout: 15_000 }).toBe(phase)
  const winner = (await actor.snapshot()).submissions.find(
    (submission) => submission.fills[0]?.id === winningCard,
  )!
  const start = actor.events.length
  if (rules.includes('godmode')) {
    for (const peer of peers)
      peer.send({
        type: 'vote',
        submissionId:
          peer === actor
            ? (await actor.snapshot()).submissions.find(
                (submission) => submission.submissionId !== winner.submissionId,
              )!.submissionId
            : winner.submissionId,
      })
  } else if (rules.includes('survival')) {
    const round = await actor.snapshot()
    const turn = peers.find((peer) => peer.member.playerId === round.eliminationTurnPlayerId)!
    turn.send({
      type: 'eliminate',
      submissionId: round.submissions.find(
        (submission) => submission !== winner && submission.submissionId !== winner.submissionId,
      )!.submissionId,
    })
  } else if (rules.includes('serious_business')) {
    const round = await actor.snapshot()
    czar.send({
      type: 'rank',
      ranking: [
        winner.submissionId,
        ...round.submissions
          .filter((submission) => submission.submissionId !== winner.submissionId)
          .map((submission) => submission.submissionId),
      ],
    })
  } else czar.send({ type: 'pick', submissionId: winner.submissionId })
  await actor.wait('round_started', start)
  const before = await actor.snapshot()
  expect(before.round).toBe(2)
  expect(before.czarId).not.toBe(actor.member.playerId)
  return { ...initial, actor, czar: peers.find((peer) => peer.member.playerId === before.czarId)! }
}

test('an eligible player cannot wager after their primary submission', async () => {
  const { peers, actor } = await secondRound()
  try {
    const before = await actor.snapshot()
    actor.send({
      type: 'play',
      cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
      commandId: 'primary',
    })
    expect(await actor.outcome('primary')).toMatchObject({ type: 'command_accepted' })
    const submitted = await actor.snapshot()
    expect(submitted.phase).toBe('picking')
    const start = actor.events.length
    actor.send({ type: 'gamble' })
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    const after = await actor.snapshot()
    expect(after.hand).toEqual(submitted.hand)
    expect(after.myHasGambled).toBe(false)
    expect(after.mySubmissionCount).toBe(1)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('a legal wager delivers exactly one extra set privately and concurrent duplicates are rejected', async () => {
  const { peers, actor } = await secondRound()
  try {
    const before = await actor.snapshot()
    const start = actor.events.length
    const otherStarts = peers.map((peer) => peer.events.length)
    actor.send({ type: 'gamble' })
    actor.send({ type: 'gamble' })
    await actor.wait('hand_update', start)
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    const after = await actor.snapshot()
    expect(after.myHasGambled).toBe(true)
    expect(after.hand).toHaveLength(10 + before.prompt.pick)
    expect(after.hand!.slice(0, 10)).toEqual(before.hand)
    expect(after.scores).toEqual(before.scores)
    expect(actor.events.slice(start).filter((event) => event.type === 'hand_update')).toHaveLength(
      1,
    )
    expect(
      actor.events.slice(start).filter((event) => event.type === 'player_gambled'),
    ).toHaveLength(1)
    for (const [index, peer] of peers.entries()) {
      if (peer !== actor) {
        await peer.wait('player_gambled', otherStarts[index])
        expect(
          peer.events.slice(otherStarts[index]).filter((event) => event.type === 'hand_update'),
        ).toHaveLength(0)
      }
    }
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

for (const rule of ['godmode', 'survival', 'serious_business'] as const) {
  test(`${rule} rejects wagers in round two even with an earned point`, async () => {
    const { peers, actor } = await secondRound([rule])
    try {
      const before = await actor.snapshot()
      const start = actor.events.length
      actor.send({ type: 'gamble' })
      expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
      const after = await actor.snapshot()
      expect(after.hand).toEqual(before.hand)
      expect(after.myHasGambled).toBe(false)
      expect(after.scores).toEqual(before.scores)
    } finally {
      peers.forEach((peer) => peer.ws.close())
    }
  })
}

test('Czar, queued players, spectators and players without a point cannot wager', async () => {
  const { host, peers, actor, czar } = await secondRound()
  try {
    const queued = await connect(await join(host.roomCode, 'Queued'))
    const spectator = await connect(await join(host.roomCode, 'Observer', 'spectator'))
    peers.push(queued, spectator)
    const lowScore = peers.find(
      (peer) => peer !== actor && peer !== czar && peer !== queued && peer !== spectator,
    )!
    for (const [peer, code] of [
      [czar, 'not_authorized'],
      [queued, 'not_authorized'],
      [spectator, 'spectator_action'],
      [lowScore, 'score_too_low'],
    ] as const) {
      const before = await peer.snapshot()
      const start = peer.events.length
      peer.send({ type: 'gamble' })
      expect(await peer.wait('error', start)).toMatchObject({ code })
      const after = await peer.snapshot()
      expect(after.hand).toEqual(before.hand)
      expect(after.myHasGambled).toBe(false)
      expect(after.scores).toEqual(before.scores)
    }
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('a wager racing the first play either rejects or preserves every unplayed card', async () => {
  const { peers, actor } = await secondRound()
  try {
    const before = await actor.snapshot()
    const ids = before.hand!.slice(0, before.prompt.pick).map((card) => card.id)
    const start = actor.events.length
    actor.send({ type: 'gamble' })
    actor.send({ type: 'play', cardIds: ids, commandId: 'racing-play' })
    expect(await actor.outcome('racing-play')).toMatchObject({ type: 'command_accepted' })
    await expect
      .poll(() =>
        actor.events
          .slice(start)
          .some((event) => event.type === 'player_gambled' || event.type === 'error'),
      )
      .toBe(true)
    const after = await actor.snapshot()
    const survivors = before.hand!.filter((card) => !ids.includes(card.id))
    expect(after.hand!.slice(0, survivors.length)).toEqual(survivors)
    expect(after.hand).toHaveLength(after.myHasGambled ? 10 : 10 - before.prompt.pick)
    expect(after.mySubmissionCount).toBe(1)
    if (after.myHasGambled) {
      actor.send({
        type: 'play',
        cardIds: after.hand!.slice(0, before.prompt.pick).map((card) => card.id),
        commandId: 'second-play',
      })
      expect(await actor.outcome('second-play')).toMatchObject({ type: 'command_accepted' })
    }
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('a scored player cannot wager after the picking phase has ended', async () => {
  const { peers, actor, czar } = await secondRound()
  try {
    for (const peer of peers.filter((peer) => peer !== czar)) {
      const before = await peer.snapshot()
      peer.send({
        type: 'play',
        cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
      })
    }
    await expect
      .poll(async () => (await actor.snapshot()).phase, { timeout: 15_000 })
      .toBe('judging')
    const before = await actor.snapshot()
    const start = actor.events.length
    actor.send({ type: 'gamble' })
    expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    const after = await actor.snapshot()
    expect(after.hand).toEqual(before.hand)
    expect(after.myHasGambled).toBe(false)
    expect(after.submissions).toEqual(before.submissions)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})

test('paused sessions, stale rounds, expired timers and skipped players reject wagers without reserving a point', async () => {
  const { host, peers, actor } = await secondRound()
  const { default: Redis } = await import('ioredis')
  const redis = new Redis(process.env['REDIS_URL']!)
  const { default: postgres } = await import('postgres')
  const sql = postgres(process.env['DATABASE_URL']!)
  try {
    const before = await actor.snapshot()
    // Persisted-state fixtures model expiry/recovery races; observations
    // stay on the authenticated public protocol.
    const gameKey = `game:${host.roomCode}`
    const roundKey = `${gameKey}:round`
    const fixtures = [
      { key: gameKey, field: 'status', value: 'paused' },
      { key: gameKey, field: 'currentRound', value: '3' },
      { key: roundKey, field: 'roundId', value: 'stale-round' },
      { key: roundKey, field: 'roundTimerExpiresAt', value: '1' },
    ]
    for (const fixture of fixtures) {
      const previous = await redis.hget(fixture.key, fixture.field)
      await redis.hset(fixture.key, fixture.field, fixture.value)
      try {
        const start = actor.events.length
        actor.send({ type: 'gamble' })
        expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
      } finally {
        if (previous === null) await redis.hdel(fixture.key, fixture.field)
        else await redis.hset(fixture.key, fixture.field, previous)
      }
      const after = await actor.snapshot()
      expect(after.hand).toEqual(before.hand)
      expect(after.myHasGambled).toBe(false)
      expect(after.scores).toEqual(before.scores)
    }
    await redis.sadd(`${roundKey}:skipped`, actor.member.playerId)
    try {
      const start = actor.events.length
      actor.send({ type: 'gamble' })
      expect(await actor.wait('error', start)).toMatchObject({ code: 'not_authorized' })
    } finally {
      await redis.srem(`${roundKey}:skipped`, actor.member.playerId)
    }
    await sql`UPDATE game_sessions SET status = 'paused' WHERE code = ${host.roomCode}`
    try {
      const start = actor.events.length
      actor.send({ type: 'gamble' })
      expect(await actor.wait('error', start)).toMatchObject({ code: 'invalid_state' })
    } finally {
      await sql`UPDATE game_sessions SET status = 'active' WHERE code = ${host.roomCode}`
    }
    const restored = await actor.snapshot()
    expect(restored.hand).toEqual(before.hand)
    expect(restored.myHasGambled).toBe(false)
    const start = actor.events.length
    actor.send({ type: 'gamble' })
    await actor.wait('player_gambled', start)
    expect((await actor.snapshot()).hand).toHaveLength(10 + before.prompt.pick)
  } finally {
    await redis.quit()
    await sql.end()
    peers.forEach((peer) => peer.ws.close())
  }
})

test('removing a modal rule in the lobby allows a legal wager in the resulting normal game', async () => {
  const { peers, actor } = await secondRound([], ['godmode'])
  try {
    const before = await actor.snapshot()
    expect(before.config.rules).toEqual([])
    expect(before.scores.find((score) => score.playerId === actor.member.playerId)?.score).toBe(1)
    const start = actor.events.length
    actor.send({ type: 'gamble' })
    await actor.wait('player_gambled', start)
    const after = await actor.snapshot()
    expect(after.myHasGambled).toBe(true)
    expect(after.hand).toHaveLength(10 + before.prompt.pick)
    expect(after.hand!.slice(0, 10)).toEqual(before.hand)
  } finally {
    peers.forEach((peer) => peer.ws.close())
  }
})
