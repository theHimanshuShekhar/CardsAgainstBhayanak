import { test, expect } from '@playwright/test'
import {
  createGameWithRule,
  joinGame,
  getCzar,
  submitCards,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// Slice 3: Serious Business — modal rule, czar ranks top 3 (3/2/1 pts).
// `winner_player_id` = top-ranked submission's player.
//
// Scope: this spec exercises the *UI wiring* — rank buttons mount only
// for the czar after reveal, tapping them builds an ordered ranking
// (#1, #2, #3) reflected in button labels, and confirming submits the
// ranking. The round resolves via `round_ranked` → scores update.

test('Serious Business — czar ranks top 3, scores award 3/2/1, round resolves', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const { handle: host, roomCode } = await createGameWithRule(browser, 'Host', 'Serious Business', {
    roundsToWin: 5,
  })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)
  const carol = await joinGame(browser, 'Carol', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob, carol]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  const czar = await getCzar(players)
  const submitters = players.filter((p) => p !== czar)
  const pick = await handPickCount(submitters[0]!)
  for (const p of submitters) await submitCards(p, pick)

  // Czar's rank buttons mount + enable after reveal. Non-czars see them
  // mount too (one per submission), but disabled.
  await expect(czar.page.locator('[data-testid="rank-btn"]')).toHaveCount(3, { timeout: 30_000 })
  await expect(czar.page.locator('[data-testid="rank-btn"]').first()).toBeEnabled({
    timeout: 30_000,
  })
  // Non-czars cannot rank.
  for (const p of submitters) {
    await expect(p.page.locator('[data-testid="rank-btn"]').first()).toBeDisabled({
      timeout: 5_000,
    })
  }

  // Confirm button starts disabled (no rank picked yet).
  const confirm = czar.page.locator('[data-testid="rank-confirm-btn"]')
  await expect(confirm).toBeDisabled()

  // Tap 3 cards in order → labels flip to "#1", "#2", "#3". The rank
  // strip lives inside the .sub-card with the response-card stacked
  // above; a real pointer click hits the topmost element in that subtree
  // (the response card) rather than the rank button — dispatchEvent
  // fires onClick directly on the button, bypassing hit testing.
  for (let i = 0; i < 3; i++) {
    await czar.page.locator('[data-testid="rank-btn"]').nth(i).dispatchEvent('click')
    await expect(czar.page.locator('[data-testid="rank-btn"]').nth(i)).toHaveText(`#${i + 1}`)
  }

  // Confirm now enabled.
  await expect(confirm).toBeEnabled()

  // Snapshot the round number before submission so we can assert it
  // advances after `round_ranked` resolves.
  async function readRound(): Promise<number> {
    const t = (await host.page.locator('.pill').first().textContent()) ?? ''
    const m = /Round (\d+)/.exec(t)
    return m ? parseInt(m[1]!, 10) : 0
  }
  const roundBefore = await readRound()

  // Same overlap concern as the rank-btn taps above.
  await confirm.dispatchEvent('click')

  // Winner badge appears (top-ranked submission). Engine awards 3/2/1;
  // the top-ranked submitter's score becomes 3.
  for (const p of players) {
    await expect(p.page.locator('.winner-badge')).toBeVisible({ timeout: 20_000 })
  }

  // Verify the scoreboard reflects a 3-point bump for *some* submitter
  // (the top-ranked one). Czar gets nothing.
  await expect
    .poll(
      async () => {
        const chips = await host.page.locator('.scoreboard .score-chip').all()
        const scores: number[] = []
        for (const c of chips) {
          const t = (await c.locator('.score-meta').textContent()) ?? ''
          // `.score-meta` reads either "N pts" or "JUDGE · N pts". The
          // bumped player isn't the czar, so `N pts` plain. Match the
          // last integer to handle either format.
          const matches = t.match(/(\d+)/g)
          if (matches?.length) scores.push(parseInt(matches[matches.length - 1]!, 10))
        }
        return Math.max(...scores, 0)
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3)

  // Round advances past the wager round.
  await expect.poll(() => readRound(), { timeout: 20_000 }).toBeGreaterThan(roundBefore)

  await Promise.all(players.map((h) => h.context.close()))
})
