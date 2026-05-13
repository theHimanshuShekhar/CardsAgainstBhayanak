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

export const RATE_LIMITS = {
  join: { max: 10, windowSeconds: 60 },
  create: { max: 5, windowSeconds: 3600 },
  ws: { max: 60, windowSeconds: 60 },
} as const
