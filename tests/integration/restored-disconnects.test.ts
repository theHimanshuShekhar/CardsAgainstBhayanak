import { expect, it } from 'vitest'

it('restores an expired grace deadline once, preserving roster and host succession', async () => {
  const { db } = await import('../../src/db')
  const { gameSessions, gamePlayers } = await import('../../src/db/schema')
  const state = await import('../../src/lib/game-state')
  const engine = await import('../../src/lib/game-engine')
  const { redis, KEYS } = await import('../../src/lib/redis')
  const { eq } = await import('drizzle-orm')
  const code = 'DISC37'
  const config = { maxPlayers: 3, roundsToWin: 3, timer: 'Off' as const, packs: [], rules: [] }
  const [session] = await db.insert(gameSessions).values({ code, config }).returning()
  const players = await db
    .insert(gamePlayers)
    .values(
      ['Host', 'Next', 'Queued'].map((username, i) => ({
        sessionId: session!.id,
        username,
        joinedAt: new Date(Date.now() + i * 1000),
        isHost: i === 0,
        status: i === 2 ? ('queued' as const) : ('active' as const),
      })),
    )
    .returning()
  await db
    .update(gameSessions)
    .set({ hostPlayerId: players[0]!.id })
    .where(eq(gameSessions.id, session!.id))
  const subscriber = redis.duplicate()
  const events: Array<{ type: string; playerId?: string }> = []
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
    await state.disconnectPlayer(code, players[0]!.id, 'crashed-connection', 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await engine.restoreDisconnectDeadlines()
    await engine.restoreDisconnectDeadlines()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(events.filter((event) => event.type === 'player_left')).toEqual([
      { type: 'player_left', playerId: players[0]!.id },
    ])
    expect((await state.getPlayer(code, players[2]!.id))?.status).toBe('queued')
    expect((await state.getPlayer(code, players[1]!.id))?.isHost).toBe(true)
  } finally {
    const keys = await redis.keys(`game:${code}*`)
    if (keys.length) await redis.del(...keys)
    await db
      .update(gameSessions)
      .set({ hostPlayerId: null })
      .where(eq(gameSessions.id, session!.id))
    await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, session!.id))
    await db.delete(gameSessions).where(eq(gameSessions.id, session!.id))
    await subscriber.quit()
    await redis.quit()
  }
})
