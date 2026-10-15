import { afterAll, expect, it } from 'vitest'
import { serve } from 'srvx'
import postgres from 'postgres'
import type { GameConfig, ServerMessage, SessionState } from '../../src/lib/types'

if (!process.env['DATABASE_URL'] || !process.env['REDIS_URL'])
  throw new Error('Dedicated DATABASE_URL and REDIS_URL required for integration tests')

const { db } = await import('../../src/db')
const { gameSessions, gamePlayers, gameRounds, gameMatches, packs, blackCards, whiteCards } =
  await import('../../src/db/schema')
const { eq, sql } = await import('drizzle-orm')
const state = await import('../../src/lib/game-state')
const { redis } = await import('../../src/lib/redis')
const { signSessionToken } = await import('../../src/lib/session-token')
const { gameWebSocketPlugin } = await import('../../src/ws/server')
const { Route: startRoute } = await import('../../src/routes/api/games/$code/start')
const { Route: configRoute } = await import('../../src/routes/api/games/$code/config')

type Handler = (input: { request: Request; params: { code: string } }) => Promise<Response>
const start = (startRoute.options.server!.handlers as { POST: Handler }).POST
const configure = (configRoute.options.server!.handlers as { PATCH: Handler }).PATCH
const server = serve({
  port: 3143,
  hostname: '127.0.0.1',
  silent: true,
  plugins: [gameWebSocketPlugin],
  fetch: async (request) => {
    const match = new URL(request.url).pathname.match(/^\/api\/games\/([^/]+)\/(start|config)$/)
    if (!match) return new Response(null, { status: 404 })
    try {
      return await (match[2] === 'start' ? start : configure)({
        request,
        params: { code: match[1]! },
      })
    } catch {
      return new Response(null, { status: 500 })
    }
  },
})
await server.ready()
const base = server.url!.replace(/\/$/, '')
const control = postgres(process.env['DATABASE_URL']!, { max: 2 })
afterAll(async () => {
  await server.close(true)
  await control.end()
  await redis.quit()
})

async function room(code: string) {
  const [pack, alternatePack] = await db
    .select()
    .from(packs)
    .where(
      sql`(SELECT count(*) FROM white_cards WHERE pack_id = ${packs.id}) >= 100 AND (SELECT count(*) FROM black_cards WHERE pack_id = ${packs.id}) >= 3`,
    )
    .orderBy(packs.id)
    .limit(2)
  if (!pack || !alternatePack)
    throw new Error('Start fixture requires two packs with 100 white and 3 black cards')
  const alternateBlack = await db
    .select({ id: blackCards.id })
    .from(blackCards)
    .where(eq(blackCards.packId, alternatePack.id))
  const alternateWhite = await db
    .select({ id: whiteCards.id })
    .from(whiteCards)
    .where(eq(whiteCards.packId, alternatePack.id))
  const config: GameConfig = {
    maxPlayers: 4,
    roundsToWin: 5,
    timer: 'Off',
    packs: [pack.id],
    rules: [],
  }
  const [session] = await db.insert(gameSessions).values({ code, config }).returning()
  const players = await db
    .insert(gamePlayers)
    .values(
      ['Host', 'Alice', 'Bob'].map((username, i) => ({
        sessionId: session!.id,
        username,
        isHost: i === 0,
      })),
    )
    .returning()
  await db
    .update(gameSessions)
    .set({ hostPlayerId: players[0]!.id })
    .where(eq(gameSessions.id, session!.id))
  await state.createGameState(code, players[0]!.id, config)
  for (const player of players)
    await state.addPlayer(code, {
      ...player,
      joinedAt: player.joinedAt.toISOString(),
      posthogAnonId: undefined,
    })

  const peers: Array<{ playerId: string; socket: WebSocket; events: ServerMessage[] }> = []
  for (const player of players) {
    const events: ServerMessage[] = []
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/games/${code}/ws`)
    socket.onmessage = (event) => events.push(JSON.parse(String(event.data)))
    await new Promise<void>((resolve) => {
      socket.onopen = () => resolve()
    })
    socket.send(
      JSON.stringify({
        type: 'auth',
        sessionToken: await signSessionToken({ playerId: player.id, roomCode: code }),
      }),
    )
    await expect.poll(() => events.some((event) => event.type === 'auth_ok')).toBe(true)
    peers.push({ playerId: player.id, socket, events })
  }
  const token = await signSessionToken({ playerId: players[0]!.id, roomCode: code })
  return {
    config,
    alternatePackId: alternatePack.id,
    alternateBlack: new Set(alternateBlack.map((card) => card.id)),
    alternateWhite: new Set(alternateWhite.map((card) => card.id)),
    request: (action: 'start' | 'config', next?: GameConfig) =>
      fetch(`${base}/api/games/${code}/${action}`, {
        method: action === 'start' ? 'POST' : 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: next ? JSON.stringify({ config: next }) : undefined,
      }),
    async snapshots() {
      const snapshots: SessionState[] = []
      for (const peer of peers) {
        peer.events.length = 0
        peer.socket.send(JSON.stringify({ type: 'rejoin' }))
        await expect
          .poll(() => peer.events.some((event) => event.type === 'state_snapshot'))
          .toBe(true)
        const snapshot = peer.events.find((event) => event.type === 'state_snapshot')!
        if (snapshot.type === 'state_snapshot') snapshots.push(snapshot.state)
      }
      return snapshots
    },
    peers,
    async close() {
      for (const peer of peers) {
        const closed = new Promise<void>((resolve) => {
          peer.socket.onclose = () => resolve()
        })
        peer.socket.close()
        await closed
      }
      const keys = await redis.keys(`game:${code}*`)
      if (keys.length) await redis.del(...keys)
      await db
        .update(gameSessions)
        .set({ hostPlayerId: null, winnerPlayerId: null, currentMatchId: null })
        .where(eq(gameSessions.id, session!.id))
      await db.delete(gameRounds).where(eq(gameRounds.sessionId, session!.id))
      await db.delete(gameMatches).where(eq(gameMatches.sessionId, session!.id))
      await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, session!.id))
      await db.delete(gameSessions).where(eq(gameSessions.id, session!.id))
    },
  }
}

// Hold the real storage boundary to put both HTTP requests in the lock
// queue in a known order. All outcome assertions use responses/events/snapshots.
async function raceInOrder(
  code: string,
  first: () => Promise<Response>,
  second: () => Promise<Response>,
): Promise<Response[]> {
  const blocker = await control.reserve()
  const pending: Promise<Response>[] = []
  let locked = false
  try {
    await blocker`BEGIN`
    locked = true
    await blocker`SELECT id FROM game_sessions WHERE code = ${code} FOR UPDATE`
    for (const request of [first, second]) {
      pending.push(request())
      await expect
        .poll(async () => {
          const [row] = await control`
            SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
          `
          return Number(row!.waiting)
        })
        .toBe(pending.length)
    }
    await blocker`COMMIT`
    locked = false
    return await Promise.all(pending)
  } finally {
    if (locked) await blocker`ROLLBACK`
    blocker.release()
    await Promise.allSettled(pending)
  }
}

it('duplicate host starts claim one playable first round', async () => {
  const code = 'STA043'
  const fixture = await room(code)
  try {
    const responses = await raceInOrder(
      code,
      () => fixture.request('start'),
      () => fixture.request('start'),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([204, 409])
    const rejected = responses.find((response) => response.status === 409)!
    expect(await rejected.json()).toMatchObject({ code: 'invalid_state' })
    for (const peer of fixture.peers) {
      await expect
        .poll(() => peer.events.filter((event) => event.type === 'round_started').length)
        .toBe(1)
      expect(
        peer.events
          .filter((event) => event.type === 'game_started' || event.type === 'round_started')
          .map((event) => event.type),
      ).toEqual(['game_started', 'round_started'])
    }
    const snapshots = await fixture.snapshots()
    for (const snapshot of snapshots) {
      expect(snapshot.round).toBe(1)
      expect(snapshot.hand).toHaveLength(10)
      expect(snapshot.config).toEqual(fixture.config)
    }
    expect(
      new Set(snapshots.flatMap((snapshot) => snapshot.hand!.map((card) => card.id))).size,
    ).toBe(30)
  } finally {
    await fixture.close()
  }
}, 20_000)

it('can retry a failed Rando setup with one membership and one first-round publication', async () => {
  const fixture = await room('ERR043')
  const config: GameConfig = { ...fixture.config, rules: ['rando'] }
  try {
    expect((await fixture.request('config', config)).status).toBe(204)
    await control`
      CREATE FUNCTION issue43_fail_start() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'issue43 injected setup failure'; END $$
    `
    await control`
      CREATE TRIGGER issue43_fail_start BEFORE INSERT ON game_players
      FOR EACH ROW WHEN (NEW.is_rando) EXECUTE FUNCTION issue43_fail_start()
    `
    expect((await fixture.request('start')).status).toBe(500)
    for (const peer of fixture.peers)
      expect(
        peer.events.filter(
          (event) => event.type === 'game_started' || event.type === 'round_started',
        ),
      ).toEqual([])
    await control`DROP TRIGGER issue43_fail_start ON game_players`
    // A failed start must leave the lobby usable, including host edits.
    expect((await fixture.request('config', config)).status).toBe(204)
    expect((await fixture.request('start')).status).toBe(204)
    for (const peer of fixture.peers) {
      await expect
        .poll(() => peer.events.filter((event) => event.type === 'round_started').length)
        .toBe(1)
      expect(peer.events.filter((event) => event.type === 'game_started')).toHaveLength(1)
    }
    const snapshots = await fixture.snapshots()
    for (const snapshot of snapshots) {
      expect(snapshot.round).toBe(1)
      expect(snapshot.hand).toHaveLength(10)
      expect(snapshot.scores).toHaveLength(4)
      expect(snapshot.scores.filter((player) => player.isRando)).toHaveLength(1)
      expect(snapshot.expected).toBe(2)
      expect(snapshot.submitted).toBe(0)
    }
    for (const [index, snapshot] of snapshots.entries()) {
      const peer = fixture.peers[index]!
      if (peer.playerId === snapshot.czarId) continue
      peer.socket.send(
        JSON.stringify({
          type: 'play',
          cardIds: snapshot.hand!.slice(0, snapshot.prompt!.pick).map((card) => card.id),
        }),
      )
    }
    for (const peer of fixture.peers)
      await expect
        .poll(() => peer.events.filter((event) => event.type === 'card_revealed').length, {
          timeout: 5_000,
        })
        .toBe(3)
  } finally {
    await control`DROP TRIGGER IF EXISTS issue43_fail_start ON game_players`
    await control`DROP FUNCTION IF EXISTS issue43_fail_start()`
    await fixture.close()
  }
}, 20_000)

it('removes staged Rando membership when completed setup is rejected at commit', async () => {
  const fixture = await room('COM043')
  const config: GameConfig = { ...fixture.config, rules: ['rando'] }
  try {
    expect((await fixture.request('config', config)).status).toBe(204)
    await control`
      CREATE FUNCTION issue43_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'issue43 injected commit failure'; END $$
    `
    await control`
      CREATE CONSTRAINT TRIGGER issue43_reject_commit AFTER UPDATE ON game_sessions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'active')
      EXECUTE FUNCTION issue43_reject_commit()
    `
    expect((await fixture.request('start')).status).toBe(500)
    await control`DROP TRIGGER issue43_reject_commit ON game_sessions`
    for (const peer of fixture.peers) {
      expect(
        peer.events.filter(
          (event) => event.type === 'game_started' || event.type === 'round_started',
        ),
      ).toEqual([])
      peer.events.length = 0
      peer.socket.send(JSON.stringify({ type: 'rejoin' }))
      await expect
        .poll(() => peer.events.some((event) => event.type === 'lobby_snapshot'))
        .toBe(true)
      const snapshot = peer.events.findLast((event) => event.type === 'lobby_snapshot')!
      if (snapshot.type !== 'lobby_snapshot') throw new Error('Missing lobby snapshot')
      expect(snapshot.gameStatus).toBe('lobby')
      expect(snapshot.players).toHaveLength(3)
      expect(snapshot.players.some((player) => player.isRando)).toBe(false)
    }
    expect((await fixture.request('start')).status).toBe(204)
    for (const peer of fixture.peers) {
      await expect
        .poll(() => peer.events.filter((event) => event.type === 'round_started').length)
        .toBe(1)
      expect(peer.events.filter((event) => event.type === 'game_started')).toHaveLength(1)
    }
    for (const snapshot of await fixture.snapshots()) {
      expect(snapshot.round).toBe(1)
      expect(snapshot.hand).toHaveLength(10)
      expect(snapshot.scores).toHaveLength(4)
      expect(snapshot.scores.filter((player) => player.isRando)).toHaveLength(1)
      expect(snapshot.expected).toBe(2)
    }
  } finally {
    await control`DROP TRIGGER IF EXISTS issue43_reject_commit ON game_sessions`
    await control`DROP FUNCTION IF EXISTS issue43_reject_commit()`
    await fixture.close()
  }
}, 20_000)

it('preserves a host edit that wins the race with start in every active snapshot', async () => {
  const code = 'CFG043'
  const fixture = await room(code)
  const edited: GameConfig = {
    ...fixture.config,
    maxPlayers: 3,
    roundsToWin: 9,
    packs: [fixture.alternatePackId],
    rules: ['godmode', 'rando'],
  }
  try {
    const responses = await raceInOrder(
      code,
      () => fixture.request('config', edited),
      () => fixture.request('start'),
    )
    expect(responses.map((response) => response.status)).toEqual([204, 204])
    for (const peer of fixture.peers) {
      await expect
        .poll(() => peer.events.filter((event) => event.type === 'round_started').length)
        .toBe(1)
      expect(peer.events.find((event) => event.type === 'round_started')).toMatchObject({
        czarId: null,
      })
    }
    for (const snapshot of await fixture.snapshots()) {
      expect(snapshot.config).toEqual(edited)
      expect(snapshot.czarId).toBeNull()
      expect(snapshot.round).toBe(1)
      expect(snapshot.hand).toHaveLength(10)
      expect(snapshot.scores).toHaveLength(4)
      expect(snapshot.scores.filter((player) => player.isRando)).toHaveLength(1)
      expect(fixture.alternateBlack.has(snapshot.prompt!.id)).toBe(true)
      expect(snapshot.hand!.every((card) => fixture.alternateWhite.has(card.id))).toBe(true)
    }
  } finally {
    await fixture.close()
  }
}, 20_000)

it('rejects a config edit queued after start without replacing earlier valid edits', async () => {
  const code = 'STC043'
  const fixture = await room(code)
  const accepted: GameConfig = { ...fixture.config, roundsToWin: 8, rules: ['rebooting'] }
  const losing: GameConfig = { ...fixture.config, roundsToWin: 10, rules: ['godmode'] }
  try {
    expect((await fixture.request('config', accepted)).status).toBe(204)
    const [started, rejected] = await raceInOrder(
      code,
      () => fixture.request('start'),
      () => fixture.request('config', losing),
    )
    expect(started!.status).toBe(204)
    expect(rejected!.status).toBe(409)
    expect(await rejected!.json()).toMatchObject({ code: 'invalid_state' })
    for (const snapshot of await fixture.snapshots()) {
      expect(snapshot.config).toEqual(accepted)
      expect(snapshot.czarId).toBeTruthy()
      expect(snapshot.round).toBe(1)
      expect(snapshot.hand).toHaveLength(10)
    }
  } finally {
    await fixture.close()
  }
}, 20_000)
