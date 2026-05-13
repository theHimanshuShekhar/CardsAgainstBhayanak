import { describe, it, expect, beforeEach } from 'vitest'
import { redis } from './redis'
import { checkRateLimit } from './rate-limit'

describe('rate-limit', () => {
  beforeEach(async () => {
    await redis.flushdb()
  })

  it('allows requests up to max then blocks', async () => {
    const key = 'test:127.0.0.1:join'
    for (let i = 0; i < 10; i++) {
      const r = await checkRateLimit(key, 10, 60)
      expect(r.allowed).toBe(true)
    }
    const r = await checkRateLimit(key, 10, 60)
    expect(r.allowed).toBe(false)
    expect(r.resetAt).toBeGreaterThan(Date.now())
  })

  it('returns correct remaining count', async () => {
    const key = 'test:remaining'
    const r1 = await checkRateLimit(key, 5, 60)
    expect(r1.remaining).toBe(4)
    const r2 = await checkRateLimit(key, 5, 60)
    expect(r2.remaining).toBe(3)
  })

  it('independent keys do not interfere', async () => {
    const key1 = 'test:key1'
    const key2 = 'test:key2'
    for (let i = 0; i < 10; i++) await checkRateLimit(key1, 10, 60)
    const blocked = await checkRateLimit(key1, 10, 60)
    expect(blocked.allowed).toBe(false)
    const allowed = await checkRateLimit(key2, 10, 60)
    expect(allowed.allowed).toBe(true)
  })

  it('resetAt is approximately windowSeconds in the future', async () => {
    const before = Date.now()
    const r = await checkRateLimit('test:reset', 5, 60)
    expect(r.resetAt).toBeGreaterThanOrEqual(before + 60_000)
    expect(r.resetAt).toBeLessThan(before + 62_000)
  })
})
