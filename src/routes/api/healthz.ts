import { createFileRoute } from '@tanstack/react-router'
import { redis } from '~/lib/redis'
import { db } from '~/db'
import { gameSessions } from '~/db/schema'
import { count, sql } from 'drizzle-orm'
import { ensureServerBoot } from '~/lib/server-boot'

const bootTime = Date.now()
ensureServerBoot()

export const Route = createFileRoute('/api/healthz')({
  server: {
    handlers: {
      GET: async () => {
        const checks: Record<string, string> = { db: 'ok', redis: 'ok' }
        let status = 200

        try {
          await redis.ping()
        } catch {
          checks['redis'] = 'down'
          status = 503
        }

        let activeGames: number | null = null
        try {
          const [row] = await db
            .select({ value: count() })
            .from(gameSessions)
            .where(sql`${gameSessions.status} IN ('active', 'paused')`)
          activeGames = Number(row?.value ?? 0)
        } catch {
          checks['db'] = 'down'
          status = 503
        }

        // S3: only report activeGames when the DB query succeeded — a 0 here
        // when the DB is down is misleading (it's unknown, not zero).
        return Response.json(
          {
            ...checks,
            ...(activeGames !== null && { activeGames }),
            uptime: Math.floor((Date.now() - bootTime) / 1000),
          },
          { status },
        )
      },
    },
  },
})
