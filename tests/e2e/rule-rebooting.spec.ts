import { test, expect } from '@playwright/test'
import {
  createGameWithRule,
  joinGame,
  getCzar,
  submitCards,
  startReveal,
  pickWinner,
  waitForPhase,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// Slice 1: Rebooting the Universe — strict UI exercise.
//
// The Redraw button is only visible to a non-Czar player with ≥1 point.
// To get there we play one round, identify the winner from the
// scoreboard, then drive their session: click Redraw, verify the score
// drops by 1 and the hand is refreshed via the engine's hand_update.

test('Rebooting the Universe — winner redraws, loses 1 point, refills hand', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const { handle: host, roomCode } = await createGameWithRule(
    browser,
    'Host',
    'Rebooting the Universe',
    { roundsToWin: 5 },
  )
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // The Redraw button mounts only during picking for non-czar players
  // with ≥1 point. Play rounds until *some* player has both — i.e. their
  // session shows the button. With 3 players and stable czarOrder, two
  // rounds is enough in the worst case (round-1 winner becomes round-2
  // czar; round-2 winner is by definition a non-czar holding ≥1 pt).
  async function findRedrawer(): Promise<PlayerHandle | null> {
    for (const p of players) {
      if (
        await p.page
          .locator('[data-testid="redraw-btn"]')
          .isVisible()
          .catch(() => false)
      )
        return p
    }
    return null
  }

  let winner: PlayerHandle | null = null
  for (let round = 1; round <= 3 && !winner; round++) {
    const czar = await getCzar(players)
    const others = players.filter((p) => p !== czar)
    const pick = await handPickCount(others[0]!)
    for (const p of others) await submitCards(p, pick)
    await waitForPhase(players, 'judging')
    await startReveal(czar)
    await pickWinner(czar, 0)

    // Give the next round_started a moment to repaint the rule-bar.
    await host.page.waitForTimeout(800)
    winner = await findRedrawer()
  }

  expect(winner, 'expected some player to hold the Redraw button').toBeTruthy()
  const winnerName = winner!.username
  const redraw = winner!.page.locator('[data-testid="redraw-btn"]')
  await expect(redraw).toBeVisible({ timeout: 5_000 })

  // Snapshot the winner's current score from their own scoreboard chip,
  // then click Redraw. The engine should emit scores_update (–1 pt) and
  // hand_update (10 fresh cards).
  const winnerChip = winner!.page.locator('.score-chip', { hasText: winnerName })
  const preText = (await winnerChip.locator('.score-meta').textContent()) ?? ''
  const preScore = parseInt(/\b(\d+) pt/.exec(preText)?.[1] ?? '', 10)
  expect(preScore).toBeGreaterThanOrEqual(1)

  await redraw.click()

  await expect
    .poll(
      async () => {
        const t = (await winnerChip.locator('.score-meta').textContent()) ?? ''
        return parseInt(/\b(\d+) pt/.exec(t)?.[1] ?? '', 10)
      },
      { timeout: 10_000 },
    )
    .toBe(preScore - 1)

  // Hand still 10 cards — engine refilled.
  await expect(winner!.page.locator('.hand-card-wrap')).toHaveCount(10, { timeout: 10_000 })

  await Promise.all(players.map((h) => h.context.close()))
})
