import { test, expect } from '@playwright/test'
import { playConcurrentReset } from '../protocol'

const base = process.env.CAB_E2E_BASE ?? 'http://localhost:3000'
for (const modes of [
  ['rematch', 'rematch'],
  ['lobby', 'lobby'],
  ['rematch', 'lobby'],
] as const) {
  test(`concurrent ${modes.join('/')} resets claim one playable game`, async () => {
    test.setTimeout(180_000)
    const result = await playConcurrentReset(base, [...modes])
    expect(result.statuses).toEqual([204, 409])
    expect(result.errors[0]).toMatchObject({ code: 'invalid_state' })
    expect(result.resets).toEqual([result.winner])
    for (const snapshot of result.snapshots) {
      expect(snapshot?.round).toBe(1)
      expect(snapshot?.hand).toHaveLength(10)
      expect(snapshot?.scores).toHaveLength(3)
      expect(snapshot?.scores.every((score: { score: number }) => score.score === 0)).toBe(true)
      expect(new Set(snapshot?.hand.map((card: { id: string }) => card.id)).size).toBe(10)
    }
    expect(result.playable).toBe(true)
  })
}
