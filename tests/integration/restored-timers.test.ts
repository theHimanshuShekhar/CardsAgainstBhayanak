import { expect, it, vi } from 'vitest'

// Run only with dedicated PostgreSQL/Redis databases. Only Date and the
// round timeout boundary are controlled; performance.now and service IO stay real.
it('restored and ordinary timeouts cannot skip or void a rematch with the same round number', async () => {
  if (!process.env['DATABASE_URL'] || !process.env['REDIS_URL'])
    throw new Error('Dedicated DATABASE_URL and REDIS_URL required for integration tests')
  const { db } = await import('../../src/db')
  const { gameSessions, gamePlayers, gameRounds, gameMatches, packs } =
    await import('../../src/db/schema')
  const { eq } = await import('drizzle-orm')
  const state = await import('../../src/lib/game-state')
  const engine = await import('../../src/lib/game-engine')
  const { redis, KEYS } = await import('../../src/lib/redis')
  const code = 'TMR040'
  // The engine's public event stream is the same stream forwarded to WS
  // clients. Read behavior here rather than inspecting stored round state.
  const subscriber = redis.duplicate()
  const events: Array<{ type: string; round?: number; roundTimerExpiresAt?: number }> = []
  subscriber.on('message', (_channel, raw) => events.push(JSON.parse(raw)))
  await subscriber.subscribe(KEYS.channel(code))
  const drainEvents = async () => {
    const received = new Promise<void>((resolve) => {
      const onMessage = (_channel: string, raw: string) => {
        if (raw !== '{"type":"test_barrier"}') return
        subscriber.off('message', onMessage)
        resolve()
      }
      subscriber.on('message', onMessage)
    })
    await redis.publish(KEYS.channel(code), '{"type":"test_barrier"}')
    await received
    events.splice(0, events.length, ...events.filter((event) => event.type !== 'test_barrier'))
  }
  const callbacks: Array<() => Promise<void>> = []
  const realTimeout = globalThis.setTimeout
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  const timeout = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
    if (ms === 30_000) {
      callbacks.push(callback as () => Promise<void>)
      return realTimeout(() => {}, 1_000_000_000).unref()
    }
    return realTimeout(callback, ms, ...args)
  })
  const [pack] = await db.select().from(packs).limit(1)
  expect(pack).toBeDefined()
  const config = {
    maxPlayers: 3,
    roundsToWin: 3,
    timer: '30s' as const,
    packs: [pack!.id],
    rules: [],
  }
  const [session] = await db.insert(gameSessions).values({ code, config }).returning()
  try {
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
    await state.createGameState(code, players[0]!.id, config)
    for (const player of players)
      await state.addPlayer(code, {
        ...player,
        joinedAt: player.joinedAt.toISOString(),
        posthogAnonId: player.posthogAnonId ?? undefined,
      })
    await engine.startGame(code)
    callbacks.length = 0
    await engine.startRound(code, 1)
    await engine.restoreRoundTimers()
    expect(callbacks).toHaveLength(2)
    await engine.endGame(code, 'normal', players[0]!.id)
    clock.mockReturnValue(1_800_000_001_000)
    await engine.resetGame(code, 'rematch')
    await drainEvents()
    const newRound = events.filter((event) => event.type === 'round_started').at(-1)!
    expect(newRound.round).toBe(1)
    const deadline = newRound.roundTimerExpiresAt!
    events.length = 0
    clock.mockReturnValue(1_800_000_030_000)
    // Await complete callbacks, including real service IO, before proving
    // neither ordinary nor restored stale work changed the new match.
    await callbacks[0]!()
    await callbacks[1]!()
    await drainEvents()
    expect(events).toEqual([])
    // Prove an authoritative restored timeout still skips/voids normally.
    clock.mockReturnValue(deadline!)
    timeout.mockRestore()
    await engine.restoreRoundTimers()
    await vi.waitFor(() =>
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'player_skipped', round: 1 }),
          expect.objectContaining({ type: 'round_started', round: 2 }),
        ]),
      ),
    )
  } finally {
    timeout.mockRestore()
    clock.mockRestore()
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
    await subscriber.quit()
    await redis.quit()
  }
})
