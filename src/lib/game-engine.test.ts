import { describe, it, expect, beforeEach } from 'vitest'
import { seedRng } from './rng'
import { chooseFirstCzar, toPlayerScores } from './game-engine'
import type { GamePlayer } from './types'

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

  describe('toPlayerScores', () => {
    const mk = (over: Partial<GamePlayer>): GamePlayer => ({
      id: 'p1',
      username: 'Alice',
      role: 'player',
      status: 'active',
      score: 3,
      isHost: false,
      isRando: false,
      discardsUsed: 0,
      joinedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    })

    it('excludes dropped players so a left/rejoined player is not a ghost chip', () => {
      // A player who disconnected past grace (status=dropped, score frozen)
      // plus their rejoined self (new id, score 0). The dropped ghost must
      // not appear — that duplicate same-name 0pt chip reads as "points
      // weirdly reducing".
      const players: GamePlayer[] = [
        mk({ id: 'a-old', username: 'Alice', status: 'dropped', score: 4 }),
        mk({ id: 'a-new', username: 'Alice', status: 'active', score: 0 }),
        mk({ id: 'b', username: 'Bob', status: 'active', score: 2 }),
      ]
      const scores = toPlayerScores(players, 'b')
      expect(scores.map((s) => s.playerId)).toEqual(['a-new', 'b'])
      expect(scores.find((s) => s.playerId === 'a-old')).toBeUndefined()
    })

    it('keeps grace players (temporary disconnect, may return)', () => {
      const players: GamePlayer[] = [mk({ id: 'g', status: 'grace', score: 5 })]
      expect(toPlayerScores(players, null)).toHaveLength(1)
    })

    it('marks the czar via czarId, not stale flags', () => {
      const players: GamePlayer[] = [
        mk({ id: 'p1', score: 1 }),
        mk({ id: 'p2', username: 'Bob', score: 2 }),
      ]
      const scores = toPlayerScores(players, 'p2')
      expect(scores.find((s) => s.playerId === 'p2')?.isJudge).toBe(true)
      expect(scores.find((s) => s.playerId === 'p1')?.isJudge).toBe(false)
    })
  })
})
