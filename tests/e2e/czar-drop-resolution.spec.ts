import { test, expect } from '@playwright/test'
import Redis from 'ioredis'
import postgres from 'postgres'
import { requestStateSnapshot } from '../ws-snapshot'
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
    async wait<T extends ServerToClientEvent['type']>(type: T, after = 0, timeout = 10_000) {
      await expect
        .poll(() => events.slice(after).find((event) => event.type === type), { timeout })
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
    username: 'ResolutionHost',
    anonId: 'resolution-host',
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
  const czar = peers.find((peer) => peer.playerId === initial.czarId)
  return { host, peers, czar, close: () => peers.forEach((peer) => peer.ws.close()) }
}

async function ready(game: Awaited<ReturnType<typeof start>>, completeReveal = true) {
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
  if (!completeReveal) return
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

test('permanent Czar leave resolves a revealed normal round once instead of voiding it', async () => {
  const game = await start()
  try {
    await ready(game)
    const observer = game.peers.find((peer) => peer !== game.czar)!
    const submissions = (await observer.snapshot()).submissions
    const departure = post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)
    const outcome = await observer.wait('round_won')
    expect(outcome.winningPlayerId).toBe(outcome.winnerId)
    expect(outcome.winningSubmissionId).toBe(outcome.submissionId)
    expect(await observer.snapshot()).toMatchObject({
      winningPlayerId: outcome.winningPlayerId,
      winningSubmissionId: outcome.winningSubmissionId,
    })
    expect((await departure).status).toBe(204)
    expect(submissions.some((submission) => submission.submissionId === outcome.submissionId)).toBe(
      true,
    )
    expect(outcome.scores.map((score) => score.score).sort()).toEqual([0, 0, 1])
    await observer.wait('round_end')
    await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
    expect(
      (await post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)).status,
    ).toBe(401)
    expect(observer.events.filter((event) => event.type === 'round_won')).toHaveLength(1)
    expect(observer.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
    expect(observer.events.some((event) => event.type === 'round_voided')).toBe(false)
    for (const peer of game.peers.filter((peer) => peer !== game.czar))
      expect((await peer.snapshot()).hand).toHaveLength(10)
  } finally {
    game.close()
  }
})

test('permanent Czar leave awards the Serious Business podium and advances the round', async () => {
  const game = await start(['serious_business'])
  try {
    await ready(game)
    const observer = game.peers.find((peer) => peer !== game.czar)!
    const before = await observer.snapshot()
    const departure = post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)
    const outcome = await observer.wait('round_ranked')
    expect(outcome.winningSubmissionId).toBe(outcome.ranking[0]!.submissionId)
    expect(outcome.scoresDelta[outcome.winningPlayerId]).toBe(3)
    expect(await observer.snapshot()).toMatchObject({
      winningPlayerId: outcome.winningPlayerId,
      winningSubmissionId: outcome.winningSubmissionId,
    })
    expect((await departure).status).toBe(204)
    expect(outcome.ranking.map((submission) => submission.rank)).toEqual([1, 2, 3])
    expect(new Set(outcome.ranking.map((submission) => submission.submissionId)).size).toBe(3)
    expect(
      outcome.ranking.every((ranked) =>
        before.submissions.some(
          (submission) =>
            submission.submissionId === ranked.submissionId &&
            JSON.stringify(submission.fills) === JSON.stringify(ranked.fills),
        ),
      ),
    ).toBe(true)
    expect(Object.values(outcome.scoresDelta).sort()).toEqual([1, 2, 3])
    await observer.wait('round_end')
    await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
    expect((await observer.snapshot()).scores.map((score) => score.score).sort()).toEqual([1, 2, 3])
    expect(observer.events.some((event) => event.type === 'round_voided')).toBe(false)
    expect(observer.events.filter((event) => event.type === 'round_ranked')).toHaveLength(1)
  } finally {
    game.close()
  }
})

test('permanent Survival Czar leave eliminates remaining answers without reviving earlier eliminations', async () => {
  const game = await start(['survival'])
  try {
    await ready(game)
    const observer = game.peers.find((peer) => peer !== game.czar)!
    const initial = await observer.snapshot()
    const eliminator = game.peers.find((peer) => peer.playerId === initial.eliminationTurnPlayerId)!
    eliminator.send({ type: 'eliminate', submissionId: '0' })
    await observer.wait('card_eliminated')
    const departure = post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)
    const outcome = await observer.wait('round_won')
    expect(outcome.winningPlayerId).toBe(outcome.winnerId)
    expect(outcome.winningSubmissionId).toBe(outcome.submissionId)
    expect(await observer.snapshot()).toMatchObject({
      winningPlayerId: outcome.winningPlayerId,
      winningSubmissionId: outcome.winningSubmissionId,
    })
    expect((await departure).status).toBe(204)
    expect(outcome.submissionId).not.toBe('0')
    expect(
      initial.submissions.some((submission) => submission.submissionId === outcome.submissionId),
    ).toBe(true)
    expect(outcome.scores.map((score) => score.score).sort()).toEqual([0, 0, 1])
    await observer.wait('round_end')
    await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
    expect(observer.events.filter((event) => event.type === 'card_eliminated')).toHaveLength(2)
    expect(observer.events.filter((event) => event.type === 'round_won')).toHaveLength(1)
    expect(observer.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
    expect(observer.events.some((event) => event.type === 'round_voided')).toBe(false)
  } finally {
    game.close()
  }
})

for (const rules of [[], ['survival'], ['serious_business']] as RuleId[][]) {
  test(`permanent ${rules[0] ?? 'normal'} Czar leave during reveal resolves without stale reveal events`, async () => {
    const game = await start(rules)
    try {
      const observer = game.peers.find((peer) => peer !== game.czar)!
      await ready(game, false)
      await observer.wait('reveal_start')
      expect((await observer.snapshot()).phase).toBe('reveal')
      expect(
        (await post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)).status,
      ).toBe(204)
      if (rules.includes('serious_business')) {
        const outcome = await observer.wait('round_ranked')
        expect(Object.values(outcome.scoresDelta).sort()).toEqual([1, 2, 3])
      } else {
        const outcome = await observer.wait('round_won')
        expect(outcome.scores.map((score) => score.score).sort()).toEqual([0, 0, 1])
      }
      const outcomeIndex = observer.events.findIndex((event) =>
        ['round_won', 'round_ranked'].includes(event.type),
      )
      const reveals = observer.events
        .slice(0, outcomeIndex)
        .filter((event) => event.type === 'card_revealed')
      expect(reveals).toHaveLength(3)
      expect(new Set(reveals.map((event) => event.submissionIndex)).size).toBe(3)
      expect(reveals.every((event) => event.fills.length > 0)).toBe(true)
      await observer.wait('round_end')
      await observer.wait(
        'round_started',
        observer.events.findIndex((event) => event.type === 'round_end'),
      )
      const boundary = observer.events.findIndex((event) => event.type === 'round_end')
      // Wait past every remaining stagger using the public rejoin response.
      await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      expect((await observer.snapshot()).phase).toBe('picking')
      expect(
        observer.events
          .slice(boundary)
          .some((event) =>
            ['card_revealed', 'elimination_turn', 'round_ranked', 'round_won'].includes(event.type),
          ),
      ).toBe(false)
      expect(observer.events.some((event) => event.type === 'round_voided')).toBe(false)
      expect(observer.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
    } finally {
      game.close()
    }
  })
}

for (const rules of [[], ['survival'], ['serious_business']] as RuleId[][]) {
  test(`permanent ${rules[0] ?? 'normal'} Czar grace expiry resolves the revealed round`, async () => {
    test.setTimeout(60_000)
    const game = await start(rules)
    const heartbeat = setInterval(() => {
      for (const peer of game.peers.filter((peer) => peer !== game.czar))
        peer.send({ type: 'ping' })
    }, 10_000)
    try {
      await ready(game)
      const observer = game.peers.find((peer) => peer !== game.czar)!
      game.czar!.ws.close()
      // A clean disconnect is recoverable throughout the grace window.
      await expect
        .poll(async () => (await observer.snapshot()).phase)
        .toBe(
          rules.includes('survival')
            ? 'eliminating'
            : rules.includes('serious_business')
              ? 'ranking'
              : 'judging',
        )
      expect(
        observer.events.some((event) =>
          ['round_won', 'round_ranked', 'round_end'].includes(event.type),
        ),
      ).toBe(false)
      await observer.wait('player_left', 0, 40_000)
      if (rules.includes('serious_business')) {
        const outcome = await observer.wait('round_ranked')
        expect(Object.values(outcome.scoresDelta).sort()).toEqual([1, 2, 3])
      } else {
        const outcome = await observer.wait('round_won')
        expect(outcome.scores.map((score) => score.score).sort()).toEqual([0, 0, 1])
      }
      await observer.wait('round_end')
      await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
      expect(observer.events.some((event) => event.type === 'round_voided')).toBe(false)
      expect(observer.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
    } finally {
      clearInterval(heartbeat)
      game.close()
    }
  })
}

test('a permanent Czar leave while picking returns submitted cards and rotates without awarding points', async () => {
  const game = await start()
  try {
    const observer = game.peers.find((peer) => peer !== game.czar)!
    const before = await observer.snapshot()
    const cards = before.hand!.slice(0, before.prompt.pick).map((card) => card.id)
    observer.send({ type: 'play', cardIds: cards, commandId: 'partial-round' })
    await observer.wait('command_accepted')
    expect(
      (await post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)).status,
    ).toBe(204)
    const voided = await observer.wait('round_voided')
    expect(voided).toMatchObject({ round: 1, reason: 'czar_dropped' })
    await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
    const after = await observer.snapshot()
    expect(after.czarId).not.toBe(game.czar!.playerId)
    expect(cards.every((id) => after.hand!.some((card) => card.id === id))).toBe(true)
    expect(after.scores.map((score) => score.score)).toEqual([0, 0, 0])
    expect(observer.events.some((event) => event.type === 'round_won')).toBe(false)
  } finally {
    game.close()
  }
})

test('Czar departure after a normal outcome does not award a second point or void the finished round', async () => {
  const game = await start()
  try {
    await ready(game)
    const observer = game.peers.find((peer) => peer !== game.czar)!
    let departure: Promise<Response> | undefined
    observer.ws.addEventListener('message', (event) => {
      if (JSON.parse(String(event.data)).type === 'round_won')
        departure = post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)
    })
    game.czar!.send({ type: 'pick', submissionId: '0', commandId: 'finished-before-leave' })
    await observer.wait('round_won')
    expect((await departure!).status).toBe(204)
    await observer.wait('round_end')
    await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
    expect((await observer.snapshot()).scores.map((score) => score.score).sort()).toEqual([0, 0, 1])
    expect(observer.events.filter((event) => event.type === 'round_won')).toHaveLength(1)
    expect(observer.events.filter((event) => event.type === 'round_end')).toHaveLength(1)
    expect(observer.events.some((event) => event.type === 'round_voided')).toBe(false)
  } finally {
    game.close()
  }
})

test('a delayed Survival Czar departure cannot resolve after the live room expires', async () => {
  const game = await start(['survival'])
  const redis = new Redis(process.env['REDIS_URL']!)
  const sql = postgres(process.env['DATABASE_URL']!, { max: 2 })
  let unlock!: () => void
  let locked!: () => void
  const readyLock = new Promise<void>((resolve) => {
    locked = resolve
  })
  const release = new Promise<void>((resolve) => {
    unlock = resolve
  })
  let transaction: Promise<unknown> | undefined
  try {
    await ready(game)
    const observer = game.peers.find((peer) => peer !== game.czar)!
    transaction = sql.begin(async (tx) => {
      await tx`lock table game_rounds in access exclusive mode`
      locked()
      await release
    })
    await readyLock
    const departureAfter = observer.events.length
    const departure = post(`/api/games/${game.host.roomCode}/leave`, {}, game.czar!.sessionToken)
    expect(await observer.wait('player_left', departureAfter)).toMatchObject({
      playerId: game.czar!.playerId,
    })
    await expect
      .poll(async () => {
        const rows =
          await sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
        return rows[0]!.count
      })
      .toBeGreaterThan(0)
    // The authenticated leave is already pending; only the live root
    // expires. Membership, submissions and round identity survive.
    const root = `game:${game.host.roomCode}`
    await redis.pexpire(root, 1)
    await expect.poll(() => redis.exists(root)).toBe(0)
    const after = observer.events.length
    unlock()
    await transaction
    const response = await departure
    expect(
      observer.events
        .slice(after)
        .some((event) =>
          ['card_eliminated', 'round_won', 'round_end', 'round_started'].includes(event.type),
        ),
    ).toBe(false)
    expect(response.status).toBe(204)
    expect(await redis.exists(root), 'fallback must not recreate the expired room').toBe(0)
    expect(
      (await post(`/api/games/${game.host.roomCode}/leave`, {}, observer.sessionToken)).status,
    ).toBe(401)
    observer.send({ type: 'ping' })
    expect(await observer.wait('auth_error', after)).toMatchObject({ code: 'invalid_token' })
  } finally {
    unlock?.()
    await transaction
    game.close()
    await redis.quit()
    await sql.end()
  }
})

test('expiry during the reveal delay cannot publish retained answers or advance Survival turns', async () => {
  const game = await start(['survival'])
  const redis = new Redis(process.env['REDIS_URL']!)
  try {
    const observer = game.peers.find((peer) => peer !== game.czar)!
    await ready(game, false)
    await observer.wait('reveal_start')
    const root = `game:${game.host.roomCode}`
    await redis.pexpire(root, 1)
    await expect.poll(() => redis.exists(root)).toBe(0)
    const after = observer.events.length
    // The three pending stagger callbacks and final handoff must finish
    // without delivering retained card data or opening an elimination turn.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(
      observer.events
        .slice(after)
        .some((event) =>
          ['card_revealed', 'elimination_turn', 'round_won', 'round_end'].includes(event.type),
        ),
    ).toBe(false)
    observer.send({ type: 'ping' })
    expect(await observer.wait('auth_error', after)).toMatchObject({ code: 'invalid_token' })
  } finally {
    game.close()
    await redis.quit()
  }
})
