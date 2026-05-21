import { test, expect } from '@playwright/test'
import { createGameWithRule, joinGame, getCzar, type PlayerHandle } from '../helpers'

// Slice 1: Never Have I Ever — confession discard.
//
// Non-czar players see a "Discard (0/3)" button during picking. Clicking
// it arms discard mode ("Tap a card to discard…"), and the next hand-card
// tap fires `confess_discard`. The engine refills the hand and broadcasts
// `hand_update` with the new discardsUsed; the counter on the button
// must reflect that.

test('Never Have I Ever — discard a card, counter increments, hand refills', async ({
  browser,
}) => {
  test.setTimeout(90_000)
  const { handle: host, roomCode } = await createGameWithRule(
    browser,
    'Host',
    'Never Have I Ever',
    { roundsToWin: 5 },
  )
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  const czar = await getCzar(players)
  const nonCzar = players.find((p) => p !== czar)!

  // The Czar should NOT see the discard button — NHIE is for hand-holders.
  await expect(czar.page.locator('[data-testid="discard-btn"]')).toBeHidden({ timeout: 10_000 })

  const discardBtn = nonCzar.page.locator('[data-testid="discard-btn"]')
  await expect(discardBtn).toBeVisible({ timeout: 15_000 })
  await expect(discardBtn).toContainText('(0/3)')

  // Arm discard mode.
  await discardBtn.click()
  await expect(discardBtn).toContainText('Tap a card to discard')
  await expect(discardBtn).toHaveClass(/is-armed/)

  // Tap the first hand card → confess_discard fires.
  const firstCard = nonCzar.page.locator('.hand-card-wrap').first().locator('.card-response')
  await firstCard.dispatchEvent('click')

  // Counter increments; mode disarms; hand still 10 cards.
  await expect(discardBtn).toContainText('(1/3)', { timeout: 10_000 })
  await expect(discardBtn).not.toHaveClass(/is-armed/)
  await expect(nonCzar.page.locator('.hand-card-wrap')).toHaveCount(10)

  await Promise.all(players.map((h) => h.context.close()))
})
