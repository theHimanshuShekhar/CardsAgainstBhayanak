import { test, expect } from '@playwright/test'
import {
  createGameWithRule,
  joinGame,
  submitCards,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

test('God Is Dead — own answers stay disabled and legal ballots advance the round', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { handle: host, roomCode } = await createGameWithRule(browser, 'Host', 'God Is Dead', {
    roundsToWin: 5,
  })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Godmode has no czar — every player sees their own hand-dock.
  await Promise.all(players.map((p) => p.page.locator('.hand-dock').waitFor({ timeout: 15_000 })))
  const pick = await handPickCount(host)
  for (const p of players) await submitCards(p, pick)

  await Promise.all(
    players.map((p) =>
      expect(p.page.locator('[data-testid="vote-btn"]:enabled').first()).toBeEnabled({
        timeout: 45_000,
      }),
    ),
  )

  // Every page renders one button + one tally chip per submission.
  for (const p of players) {
    await expect(p.page.locator('[data-testid="vote-btn"]')).toHaveCount(3)
    await expect(p.page.locator('[data-testid="vote-tally"]')).toHaveCount(3)
  }

  for (const p of players) {
    await expect(p.page.getByRole('button', { name: 'Your answer' })).toBeDisabled()
    await p.page.locator('[data-testid="vote-btn"]:enabled').first().click()
    // Confirmed ballots disable further choices.
    await expect(p.page.locator('[data-testid="vote-btn"]').first()).toBeDisabled({
      timeout: 5_000,
    })
  }

  await Promise.all(
    players.map((p) =>
      expect(p.page.locator('.pill', { hasText: 'Round 2' })).toBeVisible({ timeout: 15_000 }),
    ),
  )

  await Promise.all(players.map((h) => h.context.close()))
})
