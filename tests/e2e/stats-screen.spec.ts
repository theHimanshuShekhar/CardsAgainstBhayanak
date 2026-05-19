import { test, expect } from '@playwright/test'
import { playRound } from '../protocol'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'

// Root cause regression: round outcomes were never persisted to
// game_rounds (winner_player_id / winning_submission_fills stayed NULL —
// results lived only in Redis). That made "Rounds judged" count every
// round ever *started* across all sessions, and made "Top cards"
// permanently empty (its query filters winning_submission_fills IS NOT
// NULL). After one judged round, the winning card must surface in
// /api/stats topCards.
test('judged round persists winning fills → topCards populated (protocol)', async () => {
  test.setTimeout(60_000)
  const r = await playRound(BASE, { rules: [], players: 3 })
  expect(r.roundWon, 'a round must resolve so a winner exists').toBe(true)

  const res = await fetch(BASE + '/api/stats')
  expect(res.status).toBe(200)
  const stats = (await res.json()) as { topCards: { text: string; count: number }[] }
  expect(
    stats.topCards.length,
    'a judged round must surface a winning card in topCards',
  ).toBeGreaterThan(0)
})

// S2-9: /stats fetches /api/stats on mount and renders the dashboard.
// Before the fetch resolves the three "—" placeholder tiles show; after,
// the headline tiles carry real numbers and the charts render.
test('S2-9: stats screen renders aggregated data from /api/stats', async ({ page }) => {
  await page.goto('/stats')

  // Headline tiles resolve to real values (not the "—" placeholder).
  // A digit covers both a populated DB and a fresh one (0 games).
  const gamesTile = page.locator('.stat-tile', { hasText: 'Games played' })
  await expect(gamesTile.locator('.stat-value')).toHaveText(/^\d/, { timeout: 15_000 })

  // The Sparkline renders unconditionally — gamesPerDay is always a dense
  // 30-day series, even when every day is zero.
  await expect(page.locator('.chart-svg')).toBeVisible()
})
