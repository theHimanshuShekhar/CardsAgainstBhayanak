import { expect, it } from 'vitest'
import { redisFaultProxy } from '../fixtures/redis-fault-proxy'

it('restores an expired grace deadline once, preserving roster and host succession', async () => {
  const realRedisUrl = process.env['REDIS_URL']!
  const proxy = await redisFaultProxy(realRedisUrl)
  process.env['REDIS_URL'] = proxy.url
  const { db } = await import('../../src/db')
  const { gameSessions, gamePlayers, gameRounds, packs } = await import('../../src/db/schema')
  const state = await import('../../src/lib/game-state')
  const engine = await import('../../src/lib/game-engine')
  const { redis, KEYS } = await import('../../src/lib/redis')
  const { eq, sql, desc } = await import('drizzle-orm')
  const code = 'DISC37'
  const [pack] = await db.select().from(packs).orderBy(desc(packs.cardCount)).limit(1)
  const config = {
    maxPlayers: 5,
    roundsToWin: 3,
    timer: 'Off' as const,
    packs: [pack!.id],
    rules: [],
  }
  const [session] = await db.insert(gameSessions).values({ code, config }).returning()
  const players = await db
    .insert(gamePlayers)
    .values(
      ['Host', 'Next', 'Third', 'Fourth', 'Queued'].map((username, i) => ({
        sessionId: session!.id,
        username,
        joinedAt: new Date(Date.now() + i * 1000),
        isHost: i === 0,
        status: i === 4 ? ('queued' as const) : ('active' as const),
      })),
    )
    .returning()
  await db
    .update(gameSessions)
    .set({ hostPlayerId: players[0]!.id })
    .where(eq(gameSessions.id, session!.id))
  const subscriber = redis.duplicate()
  const events: Array<{
    type: string
    playerId?: string
    hostId?: string
    round?: number
    czarId?: string
    prompt?: { pick: number }
    hand?: Array<{ id: string }>
  }> = []
  subscriber.on('message', (_channel, raw) => events.push(JSON.parse(raw)))
  await subscriber.subscribe(KEYS.channel(code))
  try {
    await state.createGameState(code, players[0]!.id, config)
    for (const player of players)
      await state.addPlayer(code, {
        ...player,
        joinedAt: player.joinedAt.toISOString(),
        posthogAnonId: undefined,
      })
    await engine.startGame(code)
    const opening = await engine.startRound(code, 1, players[0]!.id)
    const openingHand = await state.getHand(code, players[1]!.id)
    await engine.submitCards(code, players[1]!.id, openingHand.slice(0, opening.prompt.pick))
    await state.disconnectPlayer(code, players[0]!.id, 'crashed-connection', 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // A real storage fault after the accepted departure simulates the
    // process losing its continuation before SQL/host succession finishes.
    await db.execute(
      sql`CREATE FUNCTION issue37_drop_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'issue37 departure boundary'; END $$`,
    )
    await db.execute(
      sql.raw(
        `CREATE TRIGGER issue37_drop_fault BEFORE UPDATE ON game_players FOR EACH ROW WHEN (NEW.id = '${players[0]!.id}' AND NEW.status = 'dropped') EXECUTE FUNCTION issue37_drop_fault()`,
      ),
    )
    await expect(engine.restoreDisconnectDeadlines()).rejects.toThrow()
    await db.execute(sql`DROP TRIGGER issue37_drop_fault ON game_players`)
    await db.execute(sql`DROP FUNCTION issue37_drop_fault()`)
    // Lose the acknowledgement only after SQL, host succession and Czar
    // progression finish. Replay must leave the successor round intact.
    await db.execute(
      sql`CREATE FUNCTION issue37_void_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'issue37 interrupted void'; END $$`,
    )
    await db.execute(
      sql.raw(
        `CREATE TRIGGER issue37_void_fault BEFORE INSERT ON game_rounds FOR EACH ROW WHEN (NEW.session_id = '${session!.id}' AND NEW.round_num = 2) EXECUTE FUNCTION issue37_void_fault()`,
      ),
    )
    await expect(engine.restoreDisconnectDeadlines()).rejects.toThrow()
    // Only remove the external fault; the transition phase, returned cards,
    // and pending continuation are recovered by the engine itself.
    await db.execute(sql`DROP TRIGGER issue37_void_fault ON game_rounds`)
    await db.execute(sql`DROP FUNCTION issue37_void_fault()`)
    proxy.failNextHashDelete(KEYS.drops(code))
    await expect(engine.restoreDisconnectDeadlines()).rejects.toThrow()
    await engine.restoreDisconnectDeadlines()
    await engine.restoreDisconnectDeadlines()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events.filter((event) => event.type === 'player_left')).toEqual([
      { type: 'player_left', playerId: players[0]!.id },
    ])
    expect(events.filter((event) => event.type === 'host_changed')).toEqual([
      { type: 'host_changed', hostId: players[1]!.id },
    ])
    const returnedHand = events.find(
      (event) => event.type === 'hand_update' && event.playerId === players[1]!.id,
    )!.hand!
    expect(returnedHand).toHaveLength(10)
    expect(new Set(returnedHand.map((card) => card.id)).size).toBe(10)
    expect(events.filter((event) => event.type === 'round_voided')).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'round_started').map((event) => event.round),
    ).toEqual([1, 2])
    // The successor round remains actionable after recovery; an extra sweep
    // cannot repeat the original Czar's round consequences.
    const nextCzar = events.find(
      (event) => event.type === 'round_started' && event.round === 2,
    )!.czarId!
    for (const player of players.slice(1, 4)) {
      if (player.id === nextCzar) continue
      const hand = await state.getHand(code, player.id)
      const pick = events.find((event) => event.type === 'round_started' && event.round === 2)!
        .prompt!.pick
      await engine.submitCards(code, player.id, hand.slice(0, pick))
    }
    await engine.pickWinner(code, nextCzar, '0')
    await engine.restoreDisconnectDeadlines()
    expect(events.filter((event) => event.type === 'round_voided')).toHaveLength(1)
  } finally {
    await db.execute(sql`DROP TRIGGER IF EXISTS issue37_void_fault ON game_rounds`)
    await db.execute(sql`DROP FUNCTION IF EXISTS issue37_void_fault()`)
    await db.execute(sql`DROP TRIGGER IF EXISTS issue37_drop_fault ON game_players`)
    await db.execute(sql`DROP FUNCTION IF EXISTS issue37_drop_fault()`)
    const keys = await redis.keys(`game:${code}*`)
    if (keys.length) await redis.del(...keys)
    await db
      .update(gameSessions)
      .set({ hostPlayerId: null })
      .where(eq(gameSessions.id, session!.id))
    await db.delete(gameRounds).where(eq(gameRounds.sessionId, session!.id))
    await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, session!.id))
    await db.delete(gameSessions).where(eq(gameSessions.id, session!.id))
    await subscriber.quit()
    await redis.quit()
    await proxy.close()
    process.env['REDIS_URL'] = realRedisUrl
  }
}, 20000)
