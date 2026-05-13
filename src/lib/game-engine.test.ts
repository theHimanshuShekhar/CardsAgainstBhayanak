import { describe, it, expect, beforeEach } from 'vitest'
import { seedRng } from './rng'
import { chooseFirstCzar } from './game-engine'

describe('game-engine', () => {
  beforeEach(() => seedRng('test-seed-2026'))

  it('chooseFirstCzar returns a value in [0, count)', () => {
    for (let i = 0; i < 50; i++) {
      const idx = chooseFirstCzar(6)
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(idx).toBeLessThan(6)
    }
  })

  it('chooseFirstCzar is deterministic with the same seed', () => {
    seedRng('seed-A')
    const a = chooseFirstCzar(6)
    seedRng('seed-A')
    const b = chooseFirstCzar(6)
    expect(a).toBe(b)
  })

  it('chooseFirstCzar distributes across all players', () => {
    const counts: Record<number, number> = {}
    for (let i = 0; i < 300; i++) {
      seedRng(`trial-${i}`)
      const idx = chooseFirstCzar(6)
      counts[idx] = (counts[idx] ?? 0) + 1
    }
    // All 6 indices should appear with 300 trials
    for (let i = 0; i < 6; i++) {
      expect(counts[i]).toBeGreaterThan(0)
    }
  })
})
