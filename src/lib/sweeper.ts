import cron from 'node-cron'
import { db } from '~/db'
import { gameSessions } from '~/db/schema'
import { redis, KEYS } from './redis'
import { sweeperLogger } from './logger'
import { sql, and, inArray } from 'drizzle-orm'

export async function sweepOnce(): Promise<number> {
  const candidates = await db
    .select()
    .from(gameSessions)
    .where(
      and(
        inArray(gameSessions.status, ['active', 'paused']),
        sql`${gameSessions.lastActivityAt} < now() - interval '6 hours'`,
      ),
    )

  let cleaned = 0
  for (const session of candidates) {
    const count = await redis.hlen(KEYS.players(session.code))
    if (count === 0) {
      await db
        .update(gameSessions)
        .set({ status: 'abandoned', endMode: 'abandoned', endedAt: new Date() })
        .where(sql`${gameSessions.id} = ${session.id}`)
      cleaned++
    }
  }
  if (cleaned > 0) sweeperLogger.info({ cleaned }, 'sweep complete')
  return cleaned
}

export function startSweeper(): void {
  cron.schedule('*/30 * * * *', () => {
    sweepOnce().catch((err) => sweeperLogger.error({ err }, 'sweep failed'))
  })
  sweeperLogger.info('sweeper scheduled')
}
