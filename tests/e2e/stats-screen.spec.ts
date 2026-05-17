import { test, expect } from '@playwright/test'

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
