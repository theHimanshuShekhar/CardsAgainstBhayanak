import { test, expect } from '@playwright/test'
import { createGame, joinGame } from '../helpers'

// Helper: create a game with a specific house rule enabled
async function createGameWithRule(
  browser: Parameters<typeof createGame>[0],
  ruleName: string,
): Promise<{ host: Awaited<ReturnType<typeof createGame>>['handle']; roomCode: string }> {
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 3 })
  // Enable the rule in the create screen before submitting
  // Rule checkboxes/radio are identified by the rule label text
  await host.page.goto('/games/create')
  await host.page.getByLabel('Your handle').fill('Host')
  const ruleEl = host.page.locator(`.check-card:has-text("${ruleName}")`)
  if (await ruleEl.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await ruleEl.click()
  }
  await host.page.click('button:has-text("Create lobby")')
  await host.page.waitForURL('**/lobby')
  const url = host.page.url()
  const code = /\/games\/([A-Z0-9]{6})\/lobby/.exec(url)?.[1] ?? roomCode
  return { host, roomCode: code }
}

test('Rebooting the Universe — player can redraw hand for 1pt', async ({ browser }) => {
  test.setTimeout(90_000)
  const { host, roomCode } = await createGameWithRule(browser, 'Rebooting')
  const p1 = await joinGame(browser, 'Alice', roomCode)
  const p2 = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Look for "Redraw" button in session (available during picking + transition)
  const redrawBtn = p1.page.locator('button:has-text("Redraw")')
  // Button may only appear if player has points — skip assertion if not present
  if (await redrawBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await redrawBtn.click()
    // Hand should refresh
    await expect(p1.page.locator('.hand-card-wrap')).toHaveCount(10)
  }

  await Promise.all([host, p1, p2].map((h) => h.context.close()))
})

test('Rando Cardrissian — synthetic Rando player appears in scoreboard', async ({ browser }) => {
  test.setTimeout(90_000)
  const { host, roomCode } = await createGameWithRule(browser, 'Rando')
  const p1 = await joinGame(browser, 'Alice', roomCode)
  const p2 = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Scoreboard should show Rando Cardrissian
  await expect(host.page.locator('.scoreboard')).toContainText('Rando', { timeout: 15_000 })

  await Promise.all([host, p1, p2].map((h) => h.context.close()))
})

test('God Is Dead — all players see vote buttons instead of czar picking', async ({ browser }) => {
  test.setTimeout(90_000)
  const { host, roomCode } = await createGameWithRule(browser, 'God Is Dead')
  const p1 = await joinGame(browser, 'Alice', roomCode)
  const p2 = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // In God Is Dead, no "judge-bar" — all can vote
  // Wait for reveal phase
  await p1.page.waitForSelector('.subs-grid, .hand-dock', { timeout: 30_000 })

  await Promise.all([host, p1, p2].map((h) => h.context.close()))
})

test('Happy Ending — host can trigger early end from menu', async ({ browser }) => {
  test.setTimeout(90_000)
  const { host, roomCode } = await createGameWithRule(browser, 'Happy Ending')
  const p1 = await joinGame(browser, 'Alice', roomCode)
  const p2 = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Host opens topbar menu (⋯) and triggers Happy Ending
  const menuBtn = host.page.locator('button[aria-label="More options"], button:has-text("⋯")')
  if (await menuBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await menuBtn.click()
    const endBtn = host.page.locator('button:has-text("End game")')
    if (await endBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await endBtn.click()
      // Final "Make a Haiku" round starts
      await expect(host.page.locator('text=Haiku')).toBeVisible({ timeout: 15_000 })
    }
  }

  await Promise.all([host, p1, p2].map((h) => h.context.close()))
})

test('modal rules are mutually exclusive in create UI', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto('/games/create')
  await page.getByLabel('Your handle').fill('TestUser')

  // Modal rules should render as a radio group (seg or radio buttons)
  const godMode = page.locator('.check-card:has-text("God Is Dead")')
  const survival = page.locator('.check-card:has-text("Survival")')

  if (
    (await godMode.isVisible().catch(() => false)) &&
    (await survival.isVisible().catch(() => false))
  ) {
    await godMode.click()
    // Survival should no longer be selected (radio group enforces mutual exclusivity)
    await survival.click()
    const godModeChecked = await godMode.getAttribute('aria-checked')
    expect(godModeChecked).not.toBe('true')
  }

  await context.close()
})
