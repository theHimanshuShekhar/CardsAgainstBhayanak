import { count, sql } from 'drizzle-orm'
import { db } from '~/db'
import { gameSessions } from '~/db/schema'
import { redis } from './redis'
import { recoveryStatus } from './recovery-status'

let databaseProbe: Promise<number | null> | undefined
let redisProbe: Promise<unknown> | undefined

// A failed connection can remain queued in a driver's reconnect loop. Bound
// health latency and share that in-flight probe instead of queuing more work.
async function bounded<T>(probe: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Health probe timed out')), 1000)
        timer.unref()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function healthResponse(): Promise<Response> {
  const checks = { db: 'ok', redis: 'ok' }
  let activeGames: number | null = null
  databaseProbe ??= (async () => {
    await db.execute(sql`SELECT 1`)
    if (recoveryStatus.stage === 'schema') return null
    const [row] = await db
      .select({ value: count() })
      .from(gameSessions)
      .where(sql`${gameSessions.status} IN ('active', 'paused')`)
    return Number(row?.value ?? 0)
  })().finally(() => {
    databaseProbe = undefined
  })
  redisProbe ??= redis.ping().finally(() => {
    redisProbe = undefined
  })
  await Promise.all([
    bounded(redisProbe).catch(() => {
      checks.redis = 'down'
    }),
    bounded(databaseProbe).then(
      (value) => {
        activeGames = value
      },
      () => {
        checks.db = 'down'
      },
    ),
  ])
  return Response.json(
    {
      ...checks,
      ...(activeGames !== null && { activeGames }),
      uptime: Math.floor(process.uptime()),
      recovery: recoveryStatus,
    },
    { status: checks.db === 'ok' && checks.redis === 'ok' && recoveryStatus.ready ? 200 : 503 },
  )
}
