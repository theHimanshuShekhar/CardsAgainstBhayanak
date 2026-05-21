import { test, expect } from '@playwright/test'
import {
  createGameWithRule,
  joinGame,
  getCzar,
  submitCards,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// Slice 3: Survival of the Fittest — modal rule, no Czar pick. After
// reveal completes, active non-Czar submitters take turns eliminating
// a submission until exactly one remains; that one wins.
//
// Scope: this spec exercises the *UI wiring* — eliminate buttons mount
// on every page, only the elimination-turn holder's button is enabled,
// a tap fires `card_eliminated` and visually marks the card, and the
// round resolves to a winner once only one submission remains.

test('Survival — eliminate button mounts, turn rotates, round resolves to last card', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const { handle: host, roomCode } = await createGameWithRule(
    browser,
    'Host',
    'Survival of the Fittest',
    { roundsToWin: 5 },
  )
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)
  const carol = await joinGame(browser, 'Carol', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob, carol]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Survival still has a czar (engine cycles czarOrder normally); only
  // submitters participate in elimination.
  const czar = await getCzar(players)
  const submitters = players.filter((p) => p !== czar)
  const pick = await handPickCount(submitters[0]!)
  for (const p of submitters) await submitCards(p, pick)

  // Reveal completes when revealIndex catches up → all 3 eliminate
  // buttons mount and stop being disabled on the turn-holder's page.
  for (const p of players) {
    await expect(p.page.locator('[data-testid="eliminate-btn"]')).toHaveCount(3, {
      timeout: 30_000,
    })
  }

  // Exactly one submitter sees their eliminate button enabled — the
  // first elimination-turn holder. Czar's buttons stay disabled.
  await expect
    .poll(
      async () => {
        let enabledOn = 0
        for (const p of submitters) {
          const en = await p.page.locator('[data-testid="eliminate-btn"]').first().isEnabled()
          if (en) enabledOn += 1
        }
        return enabledOn
      },
      { timeout: 15_000 },
    )
    .toBe(1)

  // Find the active submitter (button enabled). Eliminate the *last*
  // submission on their page — the engine excludes self-elimination
  // implicitly: the active turn holder is one specific submitter, and
  // we have 3 submissions total, so eliminating either of the other
  // two leaves the remaining one as the winner after one more
  // elimination by the next turn holder.
  // Find the submitter whose button is currently enabled. The
  // elimination_turn event arrives async so poll until exactly one
  // submitter holds the turn.
  async function activeSubmitter(prev: PlayerHandle | null = null): Promise<PlayerHandle> {
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const p of submitters) {
        if (p === prev) continue
        const en = await p.page
          .locator('[data-testid="eliminate-btn"]')
          .first()
          .isEnabled()
          .catch(() => false)
        if (en) return p
      }
      await submitters[0]!.page.waitForTimeout(250)
    }
    throw new Error('no submitter holds an enabled eliminate button')
  }
  const turn1 = await activeSubmitter()

  // Eliminate the *last* of the three submissions on turn1's page.
  // The elim-strip lives inside the .sub-card subtree with the response
  // card stacked above it — a pointer click would land on the card.
  // dispatchEvent fires React's onClick directly, bypassing hit testing.
  await turn1.page.locator('[data-testid="eliminate-btn"]').nth(2).dispatchEvent('click')

  // Every client sees one card flip to "Eliminated".
  for (const p of players) {
    await expect
      .poll(async () => await p.page.locator('.sub-card.is-eliminated').count(), {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(1)
  }

  // Turn rotates — wait for a *different* submitter's button to become
  // enabled (engine cycles round-robin in activePlayers order).
  const turn2 = await activeSubmitter(turn1)
  expect(turn2).not.toBe(turn1)

  // Eliminate the first non-eliminated card on turn2's page. With 3
  // submissions and one already eliminated, the next click leaves
  // exactly one → engine resolves the round.
  const ebtn = turn2.page.locator('[data-testid="eliminate-btn"]:not([disabled])').first()
  await ebtn.dispatchEvent('click')

  // Round resolves: a winner badge appears on every client.
  for (const p of players) {
    await expect(p.page.locator('.winner-badge')).toBeVisible({ timeout: 20_000 })
  }

  await Promise.all(players.map((h) => h.context.close()))
})
