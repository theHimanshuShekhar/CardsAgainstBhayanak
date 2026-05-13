import { describe, it, expect, beforeEach } from 'vitest'
import { seedRng, randomInt, shuffle, pick } from './rng'

describe('rng', () => {
  beforeEach(() => seedRng('test-seed'))

  it('randomInt produces values in [min, max)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomInt(5, 10)
      expect(v).toBeGreaterThanOrEqual(5)
      expect(v).toBeLessThan(10)
    }
  })

  it('same seed yields same sequence', () => {
    seedRng('abc')
    const a = [randomInt(0, 1000), randomInt(0, 1000), randomInt(0, 1000)]
    seedRng('abc')
    const b = [randomInt(0, 1000), randomInt(0, 1000), randomInt(0, 1000)]
    expect(a).toEqual(b)
  })

  it('shuffle returns a new array with the same elements', () => {
    const input = [1, 2, 3, 4, 5]
    const out = shuffle(input)
    expect(out).not.toBe(input)
    expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  it('shuffle is deterministic with same seed', () => {
    seedRng('shuf')
    const a = shuffle([1, 2, 3, 4, 5])
    seedRng('shuf')
    const b = shuffle([1, 2, 3, 4, 5])
    expect(a).toEqual(b)
  })

  it('pick returns one of the array elements', () => {
    const arr = ['a', 'b', 'c']
    for (let i = 0; i < 100; i++) expect(arr).toContain(pick(arr))
  })
})
