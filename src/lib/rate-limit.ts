import { redis } from './redis'

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number }

export async function checkRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowStart = now - windowSeconds * 1000
  const fullKey = `rl:${key}`

  const pipeline = redis.multi()
  pipeline.zremrangebyscore(fullKey, 0, windowStart)
  pipeline.zadd(fullKey, now, `${now}-${Math.random()}`)
  pipeline.zcard(fullKey)
  pipeline.expire(fullKey, windowSeconds)
  const results = await pipeline.exec()

  const count = (results?.[2]?.[1] as number) ?? 0
  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetAt: now + windowSeconds * 1000,
  }
}

// Rate limiting exists to throttle real-world abuse. The E2E suite and local
// dev run serially from a single shared IP, so production-sized create/join
// budgets trip mid-suite. Enforce only in production; dev/test pass through.
const ENFORCE = process.env['NODE_ENV'] === 'production'

export async function enforceRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (!ENFORCE) return { allowed: true, remaining: max, resetAt: Date.now() + windowSeconds * 1000 }
  return checkRateLimit(key, max, windowSeconds)
}

export const RATE_LIMITS = {
  join: { max: 10, windowSeconds: 60 },
  create: { max: 5, windowSeconds: 3600 },
  ws: { max: 60, windowSeconds: 60 },
} as const
