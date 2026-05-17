import { test, expect } from '@playwright/test'
import type { PlayerHandle } from '../helpers'
import {
  createGame,
  joinGame,
  waitForPhase,
  getCzar,
  submitCards,
  handPickCount,
  playRound,
} from '../helpers'

// Plays rounds (3 browser contexts) until a pick≥2 black card is in
// play, then runs `onMulti` with that round's Czar / non-Czars / pick
// count. roundsToWin is maxed so the game outlasts the search. The
// container's deck is server-shuffled and not RNG-seeded, so a pick≥2
// card (~10% of the deck) is not guaranteed within the round budget —
// if none appears the caller skips rather than fails (the play loop
// itself never hangs: it always submits the correct card count).
async function untilMultiBlank(
  players: PlayerHandle[],
  onMulti: (czar: PlayerHandle, nonCzars: PlayerHandle[], pick: number) => Promise<void>,
): Promise<boolean> {
  for (let round = 0; round < 24; round++) {
    await waitForPhase(players, 'picking')
    const czar = await getCzar(players)
    const nonCzars = players.filter((p) => p !== czar)
    const pick = await handPickCount(nonCzars[0]!)
    if (pick >= 2) {
      await onMulti(czar, nonCzars, pick)
      return true
    }
    await playRound(players, 1)
  }
  return false
}

async function startThreePlayerGame(browser: Parameters<typeof createGame>[0]) {
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 20 })
  const p1 = await joinGame(browser, 'Alice', roomCode)
  const p2 = await joinGame(browser, 'Bob', roomCode)
  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')
  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))
  return [host, p1, p2]
}

test('pick-2 black card shows ordered selection badges', async ({ browser }) => {
  test.setTimeout(240_000)
  const players = await startThreePlayerGame(browser)

  const found = await untilMultiBlank(players, async (_czar, nonCzars, pick) => {
    const np = nonCzars[0]!
    // The hand dock advertises the pick count ("pick 2 in order").
    await expect(np.page.locator('.hand-dock .eyebrow')).toContainText(String(pick))

    // Selecting cards stamps an ordered badge (1, then 2). dispatchEvent: a
    // selected card lifts to zIndex 99 and overlaps its neighbour, so a real
    // click would re-toggle it; firing on the exact node bypasses hit-testing.
    const cards = np.page.locator('.hand-card-wrap')
    await cards.nth(0).locator('.card-response').dispatchEvent('click')
    await expect(np.page.locator('.pick-order-badge')).toHaveCount(1)
    await cards.nth(1).locator('.card-response').dispatchEvent('click')
    await expect(np.page.locator('.pick-order-badge')).toHaveCount(2)

    const badges = np.page.locator('.pick-order-badge')
    await expect(badges.nth(0)).toHaveText('1')
    await expect(badges.nth(1)).toHaveText('2')
  })
  if (!found) test.skip(true, 'no pick≥2 card dealt within round budget')

  await Promise.all(players.map((h) => h.context.close()))
})

test('czar sees grouped multi-card submissions with player-badge index', async ({ browser }) => {
  test.setTimeout(240_000)
  const players = await startThreePlayerGame(browser)

  const found = await untilMultiBlank(players, async (czar, nonCzars, pick) => {
    for (const np of nonCzars) await submitCards(np, pick)
    await waitForPhase(players, 'judging')
    // Multi-card submissions render grouped with a per-submission badge.
    await expect(czar.page.locator('.subs-grid')).toBeVisible()
    await expect(czar.page.locator('.player-badge').first()).toBeVisible()
  })
  if (!found) test.skip(true, 'no pick≥2 card dealt within round budget')

  await Promise.all(players.map((h) => h.context.close()))
})
