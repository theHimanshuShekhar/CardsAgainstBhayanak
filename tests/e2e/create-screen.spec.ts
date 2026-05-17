import { test, expect } from '@playwright/test'

// S2-6/S2-16: the create screen must list packs (Core auto-selected and
// locked), expose modal + orthogonal house rules, and gate "Create
// lobby" on a handle plus ≥1 pack. Pure client/SSR + /api/packs — no
// game is started, so this needs no DB/Redis global setup.

test('S2-6/S2-16: create screen renders packs + rules and gates create', async ({ page }) => {
  await page.goto('/games/create')

  // Packs load and the Core base set is auto-selected + locked.
  const baseCard = page.locator('.check-card', { hasText: 'CAH Base Set' })
  await expect(baseCard).toBeVisible({ timeout: 15_000 })
  await expect(baseCard).toHaveClass(/on/)
  await expect(baseCard).toContainText('LOCKED IN')
  await expect(page.locator('.pack-grid .check-card').first()).toBeVisible()

  // Create is blocked until a handle is set (a pack is already selected).
  const createBtn = page.locator('button:has-text("Create lobby")')
  await expect(createBtn).toBeDisabled()
  await page.fill('.input.grow', 'tester')
  await expect(createBtn).toBeEnabled()

  // Modal rules are single-select: picking Survival clears God Is Dead.
  const godCard = page.locator('.check-card', { hasText: 'God Is Dead' })
  const survivalCard = page.locator('.check-card', { hasText: 'Survival of the Fittest' })
  const noneCard = page.locator('.check-card', { hasText: 'None' })
  await expect(noneCard).toHaveClass(/on/)
  await godCard.click()
  await expect(godCard).toHaveClass(/on/)
  await expect(noneCard).not.toHaveClass(/on/)
  await survivalCard.click()
  await expect(survivalCard).toHaveClass(/on/)
  await expect(godCard).not.toHaveClass(/on/)

  // Orthogonal rules stack independently of the modal selection.
  const randoCard = page.locator('.check-card', { hasText: 'Rando Cardrissian' })
  await randoCard.click()
  await expect(randoCard).toHaveClass(/on/)
  await expect(survivalCard).toHaveClass(/on/)

  // Summary reflects the selections (1 modal + 1 orthogonal = 2 rules).
  await expect(page.locator('.summary-row', { hasText: 'House rules' })).toContainText('2')
})
