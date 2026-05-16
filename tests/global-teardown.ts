import Redis from 'ioredis'

// Clears per-game state between runs. Seeded packs/cards are kept so the
// next run's global-setup doesn't have to re-fetch them.
export default async function globalTeardown(): Promise<void> {
  const { db } = await import('../src/db')
  const { sql } = await import('drizzle-orm')
  await db.execute(sql`TRUNCATE game_rounds, game_players, game_sessions RESTART IDENTITY CASCADE`)

  if (process.env['REDIS_URL']) {
    const r = new Redis(process.env['REDIS_URL'])
    await r.flushdb()
    await r.quit()
  }
}
