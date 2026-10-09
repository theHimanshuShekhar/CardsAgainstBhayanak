import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect } from '@playwright/test'
import Redis from 'ioredis'
import postgres from 'postgres'
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

async function start(rules: RuleId[] = [], roundsToWin = 20, begin = true) {
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
  for (let i = 1; i < 4; i++) members.push(await join(host.roomCode, `Player${i}`))
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

async function rejectsWithoutEffects(
  peers: Peer[],
  actor: Peer,
  command: ClientToServerEvent,
  code: 'not_authorized' | 'invalid_state',
) {
  const before = await Promise.all(peers.map((peer) => peer.snapshot()))
  const after = actor.events.length
  actor.send(command)
  const rejection = await actor.wait('error', after)
  expect(rejection).toMatchObject({ code })
  if ('commandId' in command) expect(rejection).toMatchObject({ commandId: command.commandId })
  expect(actor.events.slice(after).some((event) => event.type === 'command_accepted')).toBe(false)
  expect(await Promise.all(peers.map((peer) => peer.snapshot()))).toEqual(before)
  expect(
    actor.events
      .slice(after)
      .some((event) => ['round_won', 'round_ranked', 'round_end'].includes(event.type)),
  ).toBe(false)
}

test('only the current Czar may pick a winner, with a correlated rejection and unchanged round', async () => {
  const game = await start()
  try {
    await ready(game)
    const nonCzar = game.peers.find((peer) => peer !== game.czar)!
    await rejectsWithoutEffects(
      game.peers,
      nonCzar,
      { type: 'pick', submissionId: '0', commandId: 'unauthorized-pick' },
      'not_authorized',
    )
    game.czar!.send({ type: 'pick', submissionId: '0', commandId: 'authorized-pick' })
    expect(await game.czar!.wait('command_accepted')).toMatchObject({
      commandId: 'authorized-pick',
    })
    const outcome = await game.czar!.wait('round_won')
    expect(outcome.scores.map((score) => score.score).sort()).toEqual([0, 0, 0, 1])
    await game.czar!.wait('round_end')
    await expect.poll(async () => (await game.czar!.snapshot()).round).toBe(2)
    for (const peer of game.peers) expect((await peer.snapshot()).hand).toHaveLength(10)
  } finally {
    game.close()
  }
})

test('Serious Business ranks only current submissions after the eligible Czar is ready', async () => {
  const game = await start(['serious_business'])
  try {
    await rejectsWithoutEffects(
      game.peers,
      game.czar!,
      { type: 'rank', ranking: ['0', '1', '2'] },
      'invalid_state',
    )
    await ready(game)
    const nonCzar = game.peers.find((peer) => peer !== game.czar)!
    await rejectsWithoutEffects(
      game.peers,
      nonCzar,
      { type: 'rank', ranking: ['0', '1', '2'] },
      'not_authorized',
    )
    await rejectsWithoutEffects(
      game.peers,
      game.czar!,
      { type: 'rank', ranking: ['0', '999', '2'] },
      'invalid_state',
    )
    for (const ranking of [
      ['0', '0', '2'],
      ['0', '00', '2'],
      ['0', '1'],
    ]) {
      await rejectsWithoutEffects(
        game.peers,
        game.czar!,
        { type: 'rank', ranking },
        'invalid_state',
      )
    }
    game.czar!.send({ type: 'rank', ranking: ['0', '1', '2'] })
    const outcome = await game.czar!.wait('round_ranked')
    expect(Object.values(outcome.scoresDelta).sort()).toEqual([1, 2, 3])
    expect(outcome.ranking.map((submission) => submission.rank)).toEqual([1, 2, 3])
    await game.czar!.wait('round_end')
    await expect.poll(async () => (await game.czar!.snapshot()).round).toBe(2)
    expect((await game.czar!.snapshot()).scores.map((score) => score.score).sort()).toEqual([
      0, 1, 2, 3,
    ])
  } finally {
    game.close()
  }
})

test('a Czar pick is rejected before submissions and a stale target leaves the judging round intact', async () => {
  const game = await start()
  try {
    await rejectsWithoutEffects(
      game.peers,
      game.czar!,
      { type: 'pick', submissionId: '0', commandId: 'early-pick' },
      'invalid_state',
    )
    await ready(game)
    await rejectsWithoutEffects(
      game.peers,
      game.czar!,
      { type: 'pick', submissionId: '999', commandId: 'stale-pick' },
      'invalid_state',
    )
  } finally {
    game.close()
  }
})

for (const rules of [[], ['serious_business'], ['survival'], ['godmode']] as RuleId[][]) {
  test(`resolution commands respect configured ${rules[0] ?? 'normal'} mode`, async () => {
    const game = await start(rules)
    try {
      await ready(game)
      const actor = game.czar ?? game.peers[0]!
      if (rules.length > 0) {
        await rejectsWithoutEffects(
          game.peers,
          actor,
          { type: 'pick', submissionId: '0', commandId: 'wrong-mode-pick' },
          game.czar ? 'invalid_state' : 'not_authorized',
        )
      }
      if (!rules.includes('serious_business')) {
        await rejectsWithoutEffects(
          game.peers,
          actor,
          { type: 'rank', ranking: ['0', '1', '2'] },
          game.czar ? 'invalid_state' : 'not_authorized',
        )
      }
    } finally {
      game.close()
    }
  })
}

for (const rules of [[], ['serious_business']] as RuleId[][]) {
  test(`queued and dropped sockets cannot resolve a ${rules[0] ?? 'normal'} round`, async () => {
    const game = await start(rules)
    try {
      await ready(game)
      const queued = await connect(await join(game.host.roomCode, 'LatePlayer'))
      game.peers.push(queued)
      const command: ClientToServerEvent = rules.includes('serious_business')
        ? { type: 'rank', ranking: ['0', '1', '2'] }
        : { type: 'pick', submissionId: '0', commandId: 'ineligible-pick' }
      expect((await queued.snapshot()).hand).toBeUndefined()
      await rejectsWithoutEffects(game.peers, queued, command, 'not_authorized')
      expect(
        (await post(`/api/games/${game.host.roomCode}/leave`, {}, queued.sessionToken)).status,
      ).toBe(204)
      await game.peers[0]!.wait('player_left')
      expect(await queued.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
      await expect.poll(() => queued.ws.readyState).toBe(WebSocket.CLOSED)
      game.peers.splice(game.peers.indexOf(queued), 1)

      // HTTP leave revokes the former Czar's socket.
      // Dropping it voids the round; its old command must remain powerless.
      const formerCzar = game.czar!
      expect(
        (await post(`/api/games/${game.host.roomCode}/leave`, {}, formerCzar.sessionToken)).status,
      ).toBe(204)
      expect(await formerCzar.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
      await expect.poll(() => formerCzar.ws.readyState).toBe(WebSocket.CLOSED)
      const observer = game.peers.find((peer) => peer !== formerCzar)!
      await expect.poll(async () => (await observer.snapshot()).round).toBe(2)
      expect((await observer.snapshot()).scores.every((score) => score.score === 0)).toBe(true)
    } finally {
      game.close()
    }
  })
}

async function lobbySnapshot(peer: Peer) {
  const after = peer.events.length
  peer.send({ type: 'rejoin' })
  return peer.wait('lobby_snapshot', after)
}

// Seed server lifecycle preconditions that cannot be reached while retaining
// an eligible Czar socket through HTTP alone (e.g. pausing the session).
// Commands and every effect assertion still go through the real WS boundary.
for (const rules of [[], ['serious_business']] as RuleId[][]) {
  test(`persisted Czar eligibility, phase, and session state gate ${rules[0] ?? 'normal'} resolution`, async () => {
    const game = await start(rules)
    const redis = new Redis(process.env['REDIS_URL']!)
    const sql = postgres(process.env['DATABASE_URL']!)
    try {
      await ready(game)
      let actor = game.czar!
      const command: ClientToServerEvent = rules.includes('serious_business')
        ? { type: 'rank', ranking: ['0', '1', '2'] }
        : { type: 'pick', submissionId: '0', commandId: 'persisted-policy' }
      const playersKey = `game:${game.host.roomCode}:players`
      const roundKey = `game:${game.host.roomCode}:round`
      const activePlayer = (await redis.hget(playersKey, actor.playerId))!
      for (const status of ['grace', 'queued', 'dropped']) {
        await redis.hset(
          playersKey,
          actor.playerId,
          JSON.stringify({ ...JSON.parse(activePlayer), status }),
        )
        if (status === 'dropped') {
          const observers = game.peers.filter((peer) => peer !== actor)
          const before = await Promise.all(observers.map((peer) => peer.snapshot()))
          actor.send(command)
          expect(await actor.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
          expect(await Promise.all(observers.map((peer) => peer.snapshot()))).toEqual(before)
        } else await rejectsWithoutEffects(game.peers, actor, command, 'not_authorized')
      }
      await redis.hset(playersKey, actor.playerId, activePlayer)
      const replacement = await connect(actor)
      game.peers[game.peers.indexOf(actor)] = replacement
      actor = replacement

      const validPhase = rules.includes('serious_business') ? 'ranking' : 'judging'
      for (const phase of [
        'picking',
        'reveal',
        'waiting',
        'eliminating',
        'transition',
        rules.includes('serious_business') ? 'judging' : 'ranking',
      ]) {
        await redis.hset(roundKey, 'phase', phase)
        await rejectsWithoutEffects(game.peers, actor, command, 'invalid_state')
      }
      await redis.hset(roundKey, 'phase', validPhase)

      // The current round's persisted Czar is authoritative even when
      // the socket and client still believe this player is the judge.
      const other = game.peers.find((peer) => peer !== actor)!
      await sql`UPDATE game_rounds SET czar_player_id = ${other.playerId} WHERE session_id = (SELECT id FROM game_sessions WHERE code = ${game.host.roomCode}) AND round_num = 1`
      await rejectsWithoutEffects(game.peers, actor, command, 'not_authorized')
      await sql`UPDATE game_rounds SET czar_player_id = ${actor.playerId} WHERE session_id = (SELECT id FROM game_sessions WHERE code = ${game.host.roomCode}) AND round_num = 1`

      await sql`UPDATE game_sessions SET status = 'paused' WHERE code = ${game.host.roomCode}`
      await redis.hset(`game:${game.host.roomCode}`, 'status', 'paused')
      await rejectsWithoutEffects(game.peers, actor, command, 'invalid_state')
    } finally {
      game.close()
      await redis.quit()
      await sql.end()
    }
  })
}

test('configured mode rejects a resolution even when the persisted phase would allow it', async () => {
  const redis = new Redis(process.env['REDIS_URL']!)
  try {
    for (const rules of [[], ['serious_business'], ['survival']] as RuleId[][]) {
      const game = await start(rules)
      try {
        await ready(game)
        const rankInNormal = rules.length === 0
        await redis.hset(
          `game:${game.host.roomCode}:round`,
          'phase',
          rankInNormal ? 'ranking' : 'judging',
        )
        await rejectsWithoutEffects(
          game.peers,
          game.czar!,
          rankInNormal
            ? { type: 'rank', ranking: ['0', '1', '2'] }
            : { type: 'pick', submissionId: '0', commandId: 'persisted-mode' },
          'invalid_state',
        )
      } finally {
        game.close()
      }
    }
  } finally {
    await redis.quit()
  }
})

test('resolution is rejected in lobby and after game over without changing the session', async () => {
  for (const begin of [false, true]) {
    const game = await start(['serious_business'], 3, begin)
    try {
      const actor = game.czar ?? game.peers[0]!
      if (begin) {
        await ready(game)
        actor.send({ type: 'rank', ranking: ['0', '1', '2'] })
        await actor.wait('game_over')
      }
      const before = await lobbySnapshot(actor)
      expect(before.gameStatus).toBe(begin ? 'ended' : 'lobby')
      for (const command of [
        { type: 'pick', submissionId: '0', commandId: 'inactive-session' },
        { type: 'rank', ranking: ['0', '1', '2'] },
      ] as ClientToServerEvent[]) {
        const after = actor.events.length
        actor.send(command)
        expect(await actor.wait('error', after)).toMatchObject({ code: 'invalid_state' })
        expect(await lobbySnapshot(actor)).toEqual(before)
        expect(
          actor.events
            .slice(after)
            .some((event) =>
              ['command_accepted', 'round_ranked', 'round_won', 'round_end'].includes(event.type),
            ),
        ).toBe(false)
      }
    } finally {
      game.close()
    }
  }
})
