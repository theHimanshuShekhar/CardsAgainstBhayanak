import { afterAll, expect, it, vi } from 'vitest'
import { serve } from 'srvx'
import type { GameConfig, ServerToClientEvent, SessionState } from '../../src/lib/types'

if (!process.env['DATABASE_URL'] || !process.env['REDIS_URL'])
  throw new Error('Dedicated DATABASE_URL and REDIS_URL required for integration tests')

const { db } = await import('../../src/db')
const { gameSessions, gameMatches, gamePlayers, gameRounds, packs, blackCards, whiteCards } =
  await import('../../src/db/schema')
const { eq } = await import('drizzle-orm')
const state = await import('../../src/lib/game-state')
const engine = await import('../../src/lib/game-engine')
const { redis } = await import('../../src/lib/redis')
process.env['SESSION_SECRET'] ??= 'issue44-integration-only-session-secret'
const { signSessionToken } = await import('../../src/lib/session-token')
const { gameWebSocketPlugin } = await import('../../src/ws/server')
const server = serve({
  port: 3144,
  hostname: '127.0.0.1',
  silent: true,
  plugins: [gameWebSocketPlugin],
  fetch: () => new Response(null, { status: 404 }),
})
await server.ready()
afterAll(async () => {
  await server.close(true)
  await redis.quit()
})

async function connect(
  code: string,
  playerId: string,
  expected: 'auth_ok' | 'auth_error' = 'auth_ok',
) {
  const socket = new WebSocket(`${server.url!.replace(/^http/, 'ws')}/api/games/${code}/ws`)
  const events: ServerToClientEvent[] = []
  socket.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()))
  const send = (event: unknown) => socket.send(JSON.stringify(event))
  send({ type: 'auth', sessionToken: await signSessionToken({ roomCode: code, playerId }) })
  await expect.poll(() => events.some((event) => event.type === expected)).toBe(true)
  return {
    socket,
    events,
    send,
    async snapshot(): Promise<SessionState> {
      const start = events.length
      send({ type: 'rejoin' })
      await expect
        .poll(() => events.slice(start).find((event) => event.type === 'state_snapshot'))
        .toBeTruthy()
      const event = events.slice(start).find((event) => event.type === 'state_snapshot')!
      if (event.type !== 'state_snapshot') throw new Error('Missing snapshot')
      return event.state
    },
  }
}

async function roomFixture(code: string, usernames: string[]) {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  // Redis owns expiry time. Move only this room's real Redis deadlines by
  // elapsed time; unlike faking Date alone this actually expires old keys.
  // IO and application collaborators remain real, and no TTL is asserted.
  const advance = async (ms: number) => {
    const keys = await redis.keys(`game:${code}*`)
    if (keys.length)
      await redis.eval(
        `for _, key in ipairs(KEYS) do
          local ttl = redis.call('PTTL', key)
          if ttl >= 0 then redis.call('PEXPIRE', key, ttl - tonumber(ARGV[1])) end
        end`,
        keys.length,
        ...keys,
        ms,
      )
    now += ms
  }
  const [pack] = await db
    .insert(packs)
    .values({ name: 'Room lifetime fixture', slug: `room-lifetime-${code}` })
    .returning()
  await db.insert(blackCards).values(
    Array.from({ length: 6 }, (_, i) => ({
      packId: pack!.id,
      text: `Lifetime prompt ${i}: __________`,
      pick: 1,
    })),
  )
  await db
    .insert(whiteCards)
    .values(
      Array.from({ length: 100 }, (_, i) => ({ packId: pack!.id, text: `Lifetime answer ${i}` })),
    )
  const config: GameConfig = {
    maxPlayers: usernames.length,
    roundsToWin: 3,
    timer: 'Off',
    packs: [pack!.id],
    rules: ['never_have_i_ever'],
  }
  const [room] = await db.insert(gameSessions).values({ code, config }).returning()
  const players = await db
    .insert(gamePlayers)
    .values(
      usernames.map((username, i) => ({
        sessionId: room!.id,
        username,
        isHost: i === 0,
        joinedAt: new Date(now + i),
      })),
    )
    .returning()
  await db
    .update(gameSessions)
    .set({ hostPlayerId: players[0]!.id })
    .where(eq(gameSessions.id, room!.id))
  const peers: Awaited<ReturnType<typeof connect>>[] = []
  await state.createGameState(code, players[0]!.id, config)
  for (const player of players)
    await state.addPlayer(code, {
      ...player,
      joinedAt: player.joinedAt.toISOString(),
      posthogAnonId: undefined,
    })
  for (const player of players) peers.push(await connect(code, player.id))
  await engine.startGame(code, players[0]!.id)
  return {
    players,
    peers,
    advance,
    async cleanup() {
      clock.mockRestore()
      for (const peer of peers) peer.socket.close()
      await Promise.all(
        peers.map(
          (peer) =>
            new Promise<void>((resolve) => {
              if (peer.socket.readyState === WebSocket.CLOSED) resolve()
              else peer.socket.addEventListener('close', () => resolve(), { once: true })
            }),
        ),
      )
      const keys = await redis.keys(`game:${code}*`)
      if (keys.length) await redis.del(...keys)
      await db
        .update(gameSessions)
        .set({ hostPlayerId: null, winnerPlayerId: null, currentMatchId: null })
        .where(eq(gameSessions.id, room!.id))
      await db.delete(gameRounds).where(eq(gameRounds.sessionId, room!.id))
      await db.delete(gameMatches).where(eq(gameMatches.sessionId, room!.id))
      await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, room!.id))
      await db.delete(gameSessions).where(eq(gameSessions.id, room!.id))
      await db.delete(blackCards).where(eq(blackCards.packId, pack!.id))
      await db.delete(whiteCards).where(eq(whiteCards.packId, pack!.id))
      await db.delete(packs).where(eq(packs.id, pack!.id))
    },
  }
}

it('keeps the entire live match through its original lifetime and expires it after idle time', async () => {
  const code = 'TTL441'
  const hour = 60 * 60 * 1000
  const { players, peers, advance, cleanup } = await roomFixture(code, ['Host', 'Alice', 'Bob'])
  const originalPause = process.env['CAB_ROUND_RESULT_PAUSE_MS']
  process.env['CAB_ROUND_RESULT_PAUSE_MS'] = '1'
  try {
    const firstRound = await engine.startRound(code, 1)
    const before = await Promise.all(peers.map((peer) => peer.snapshot()))

    await advance(12 * hour)
    await engine.confessDiscard(code, players[0]!.id, before[0]!.hand![0]!.id)
    const changed = await peers[0]!.snapshot()
    expect(changed.myDiscardsUsed).toBe(1)
    await advance(13 * hour)

    // 25h since creation, but only 13h since meaningful activity: untouched
    // players' hands, roster, and phase must survive alongside the edited hand.
    const after = await Promise.all(peers.map((peer) => peer.snapshot()))
    expect(after.map((snapshot) => snapshot.hand)).toEqual([
      changed.hand,
      before[1]!.hand,
      before[2]!.hand,
    ])
    expect(after[0]).toMatchObject({ phase: 'picking', round: 1, scores: before[0]!.scores })
    const submitters = players.flatMap((player, i) =>
      player.id === firstRound.czarId ? [] : [{ player, hand: after[i]!.hand! }],
    )
    await engine.submitCards(code, submitters[0]!.player.id, [submitters[0]!.hand[0]!.id])
    await advance(12 * hour)
    await engine.submitCards(code, submitters[1]!.player.id, [submitters[1]!.hand[0]!.id])
    await advance(13 * hour)
    const judge = peers[players.findIndex((player) => player.id === firstRound.czarId)]!
    const judging = await judge.snapshot()
    expect(judging.phase).toBe('judging')
    expect(judging.submissions.map((submission) => submission.fills[0]!.id).sort()).toEqual(
      submitters.map((submitter) => submitter.hand[0]!.id).sort(),
    )
    await engine.pickWinner(code, firstRound.czarId!, judging.submissions[0]!.submissionId)
    await expect.poll(async () => (await judge.snapshot()).round).toBe(2)
    const secondRound = await judge.snapshot()
    expect(secondRound.prompt.id).not.toBe(firstRound.prompt.id)
    const rotation = players.map((player) => player.id)
    expect(secondRound.czarId).toBe(
      rotation[(rotation.indexOf(firstRound.czarId!) + 1) % rotation.length],
    )
    expect(secondRound.hand).toHaveLength(10)

    // Heartbeats, snapshots, and recovery work alone do not keep an idle
    // match alive. Valid socket leases still remain private to each socket.
    await advance(23 * hour)
    for (const peer of peers) {
      peer.send({ type: 'ping' })
      await expect.poll(() => peer.events.some((event) => event.type === 'pong')).toBe(true)
    }
    await peers[0]!.snapshot()
    await engine.restoreRoundTimers()
    await engine.restoreDisconnectDeadlines()
    await advance(2 * hour)
    const start = peers[0]!.events.length
    peers[0]!.send({ type: 'rejoin' })
    await expect
      .poll(() => peers[0]!.events.slice(start).find((event) => event.type === 'auth_error'))
      .toMatchObject({ code: 'invalid_token' })
    // Public state reads also observe cleanup, rather than surviving orphan keys.
    expect(await state.getAllPlayers(code)).toEqual([])
    expect(await state.getHand(code, players[0]!.id)).toEqual([])
    expect(await state.getPhase(code)).toBeNull()
  } finally {
    if (originalPause === undefined) delete process.env['CAB_ROUND_RESULT_PAUSE_MS']
    else process.env['CAB_ROUND_RESULT_PAUSE_MS'] = originalPause
    await cleanup()
  }
}, 30_000)

it('other players’ activity preserves the original clean-close and half-open disconnect deadlines', async () => {
  const code = 'TTL442'
  const { players, peers, advance, cleanup } = await roomFixture(code, [
    'Host',
    'Alice',
    'Bob',
    'Chloe',
  ])
  try {
    await engine.startRound(code, 1, players[3]!.id)
    const host = peers[0]!
    const alice = peers[1]!
    const bob = peers[2]!
    const chloe = peers[3]!
    bob.socket.close()
    await new Promise<void>((resolve) => {
      if (bob.socket.readyState === WebSocket.CLOSED) resolve()
      else bob.socket.addEventListener('close', () => resolve(), { once: true })
    })
    // Wait for the close handler's durable grace write, using the public
    // roster view rather than assuming that receiving close completes it.
    await expect
      .poll(async () => (await state.getPlayer(code, players[2]!.id))?.connectionStatus)
      .toBe('grace')
    const confess = async () => {
      const snapshot = await host.snapshot()
      await engine.confessDiscard(code, players[0]!.id, snapshot.hand![0]!.id)
    }
    await advance(15_000)
    await confess()
    await advance(16_000)
    await engine.restoreDisconnectDeadlines()
    const bobRetry = await connect(code, players[2]!.id, 'auth_error')
    peers.push(bobRetry)
    expect(bobRetry.events.find((event) => event.type === 'auth_error')).toMatchObject({
      code: 'player_dropped',
    })

    await advance(9_000)
    await confess()
    for (const peer of [host, chloe]) {
      peer.send({ type: 'ping' })
      await expect.poll(() => peer.events.some((event) => event.type === 'pong')).toBe(true)
    }
    await advance(6_000)
    await engine.restoreDisconnectDeadlines()
    await advance(14_000)
    await confess()
    await advance(14_000)
    await engine.restoreDisconnectDeadlines()
    expect((await host.snapshot()).scores.map((player) => player.playerId)).toContain(
      players[1]!.id,
    )
    await advance(2_000)
    await engine.restoreDisconnectDeadlines()
    // Alice's original 45s socket lease plus 30s grace ends at 75s,
    // despite accepted commands at 15s, 40s and 60s renewing the room.
    await expect
      .poll(() => alice.events.find((event) => event.type === 'auth_error'))
      .toMatchObject({ code: 'player_dropped' })
    expect((await host.snapshot()).scores.map((player) => player.playerId)).toEqual([
      players[0]!.id,
      players[3]!.id,
    ])
  } finally {
    await cleanup()
  }
}, 30_000)
