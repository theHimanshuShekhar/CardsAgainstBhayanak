import { expect, it, vi } from 'vitest'

it('repeated recovery passes share the existing round deadline and its work', async () => {
  if (!process.env['DATABASE_URL'] || !process.env['REDIS_URL'])
    throw new Error('Dedicated DATABASE_URL and REDIS_URL required for integration tests')
  const { db } = await import('../../src/db')
  const { gameSessions, gamePlayers, gameRounds, gameMatches, packs, blackCards, whiteCards } =
    await import('../../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const state = await import('../../src/lib/game-state')
  const engine = await import('../../src/lib/game-engine')
  const { redis, KEYS } = await import('../../src/lib/redis')
  const code = 'B39TMR'
  const [pack] = await db
    .insert(packs)
    .values({ name: 'Issue39 recovery fixture', slug: 'issue39-recovery', cardCount: 300 })
    .onConflictDoUpdate({ target: packs.slug, set: { cardCount: 300 } })
    .returning()
  await db
    .insert(blackCards)
    .values(
      Array.from({ length: 80 }, (_, i) => ({
        packId: pack!.id,
        text: `Issue39 prompt ${i}: __________.`,
        pick: 1,
      })),
    )
    .onConflictDoNothing()
  await db
    .insert(whiteCards)
    .values(
      Array.from({ length: 220 }, (_, i) => ({ packId: pack!.id, text: `Issue39 answer ${i}.` })),
    )
    .onConflictDoNothing()
  const config = {
    maxPlayers: 3,
    roundsToWin: 3,
    timer: '30s' as const,
    packs: [pack!.id],
    rules: [],
  }
  const [session] = await db.insert(gameSessions).values({ code, config }).returning()
  const callbacks: Array<() => Promise<void>> = []
  const realTimeout = globalThis.setTimeout
  const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (ms === 30_000) {
      callbacks.push(callback as () => Promise<void>)
      return realTimeout(() => {}, 1_000_000_000).unref()
    }
    return realTimeout(callback, ms, ...args)
  })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_039_000_000)
  const subscriber = redis.duplicate()
  const events: Array<{ type: string; round?: number }> = []
  subscriber.on('message', (_channel, raw) => events.push(JSON.parse(raw)))
  await subscriber.subscribe(KEYS.channel(code))
  try {
    const players = await db
      .insert(gamePlayers)
      .values(
        ['Host', 'Next', 'Third'].map((username, i) => ({
          sessionId: session!.id,
          username,
          isHost: i === 0,
        })),
      )
      .returning()
    await state.createGameState(code, players[0]!.id, config)
    for (const player of players)
      await state.addPlayer(code, {
        ...player,
        joinedAt: player.joinedAt.toISOString(),
        posthogAnonId: undefined,
      })
    await engine.startGame(code)
    // Setup's SQL transaction has its own timeout; observe round work only.
    callbacks.length = 0
    await engine.startRound(code, 1)
    await engine.restoreRoundTimers()
    await engine.restoreRoundTimers()
    expect(callbacks).toHaveLength(1)
    clock.mockReturnValue(1_800_039_030_000)
    await callbacks[0]!()
    await vi.waitFor(() =>
      expect(
        events.filter((event) => event.type === 'round_started' && event.round === 2),
      ).toHaveLength(1),
    )
    expect(
      events.filter((event) => event.type === 'player_skipped' && event.round === 1),
    ).toHaveLength(2)
  } finally {
    timeout.mockRestore()
    clock.mockRestore()
    await db
      .update(gameSessions)
      .set({ hostPlayerId: null, winnerPlayerId: null, currentMatchId: null })
      .where(eq(gameSessions.id, session!.id))
    await db.delete(gameRounds).where(eq(gameRounds.sessionId, session!.id))
    await db.delete(gameMatches).where(eq(gameMatches.sessionId, session!.id))
    await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, session!.id))
    await db.delete(gameSessions).where(eq(gameSessions.id, session!.id))
    const keys = await redis.keys(`game:${code}*`)
    if (keys.length) await redis.del(...keys)
    await subscriber.quit()
    await redis.quit()
  }
})
