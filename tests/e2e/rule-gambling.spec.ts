import { test, expect } from '@playwright/test'
import {
  createGame,
  joinGame,
  getCzar,
  submitCards,
  startReveal,
  pickWinner,
  waitForPhase,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// Slice 2: Gambling (base mechanic, not a house rule).
//
// Disabled in round 1 and in modal-rule games. Requires ≥1 pt and
// not-Czar. Wagering deals +pick cards into the gambler's hand and
// forces them to submit twice this round; the engine routes the second
// submission as `{playerId}:gamble` and settles the wager at round end.

test('Gambling — winner wagers on round 2, submits twice, round resolves', async ({ browser }) => {
  test.setTimeout(120_000)
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 5 })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Round 1 — Gambling is gated to round > 1, so wager-btn must not
  // appear on anyone's page. Confirm absence on the non-czars (the czar
  // has no rule-bar anyway since they don't submit).
  const r1czar = await getCzar(players)
  const r1others = players.filter((p) => p !== r1czar)
  for (const p of r1others)
    await expect(p.page.locator('[data-testid="wager-btn"]')).toBeHidden({ timeout: 5_000 })

  // Play rounds until *some* non-czar holds the wager button. The
  // round-1 winner becomes czar of round 2 (stable czarOrder), so a
  // single round leaves nobody eligible (winner is the new czar,
  // everyone else still 0pt). Two rounds always produce a second
  // winner — at minimum one of them is a non-czar for round 3.
  async function findGambler(): Promise<PlayerHandle | null> {
    for (const p of players) {
      if (
        await p.page
          .locator('[data-testid="wager-btn"]')
          .isVisible()
          .catch(() => false)
      )
        return p
    }
    return null
  }

  const pick1 = await handPickCount(r1others[0]!)
  for (const p of r1others) await submitCards(p, pick1)
  await waitForPhase(players, 'judging')
  await startReveal(r1czar)
  await expect(r1czar.page.locator('.flip-reveal .card-response')).toHaveCount(2 * pick1)
  await pickWinner(r1czar, 0)
  await host.page.waitForTimeout(800)

  let gambler = await findGambler()
  if (!gambler) {
    const r2czar = await getCzar(players)
    const r2others = players.filter((p) => p !== r2czar)
    const pick2round = await handPickCount(r2others[0]!)
    for (const p of r2others) await submitCards(p, pick2round)
    await waitForPhase(players, 'judging')
    await startReveal(r2czar)
    await expect(r2czar.page.locator('.flip-reveal .card-response')).toHaveCount(2 * pick2round)
    await pickWinner(r2czar, 0)
    await host.page.waitForTimeout(800)
    gambler = await findGambler()
  }
  expect(gambler, 'expected a non-czar with ≥1 pt to hold the Wager button').toBeTruthy()

  const curCzar = await getCzar(players)
  expect(gambler).not.toBe(curCzar)

  // Snapshot the round number on host's page before the wager round —
  // we'll assert the game advances past it without depending on the
  // exact starting value (could be 2 or 3 depending on r1 dynamics).
  async function readRound(): Promise<number> {
    const t = (await host.page.locator('.pill').first().textContent()) ?? ''
    const m = /Round (\d+)/.exec(t)
    return m ? parseInt(m[1]!, 10) : 0
  }
  const roundBefore = await readRound()

  // Snapshot pre-wager hand size — should be exactly 10.
  await expect(gambler!.page.locator('.hand-card-wrap')).toHaveCount(10, { timeout: 10_000 })
  const pick = await handPickCount(gambler!)

  // Click Wager. Engine deals `black.pick` extra cards (hand 10→10+pick).
  await gambler!.page.locator('[data-testid="wager-btn"]').click()
  await expect(gambler!.page.locator('.hand-card-wrap')).toHaveCount(10 + pick, { timeout: 10_000 })
  // Button vanishes — hasGambled now true.
  await expect(gambler!.page.locator('[data-testid="wager-btn"]')).toBeHidden({ timeout: 5_000 })

  // First play: submit the first `pick` cards. UI must stay in
  // `picking` (hand dock still visible, no waiting screen).
  const primaryTexts = (
    await gambler!.page.locator('.hand-card-wrap .card-text').allTextContents()
  ).slice(0, pick)
  await submitCards(gambler!, pick)
  await expect(gambler!.page.locator('.hand-dock')).toBeVisible({ timeout: 5_000 })
  await expect(gambler!.page.locator('.hand-card-wrap')).toHaveCount(10)
  const remainingTexts = await gambler!.page.locator('.hand-card-wrap .card-text').allTextContents()
  for (const text of primaryTexts) expect(remainingTexts).not.toContain(text)

  // Second play: submit the next `pick` cards. Now we move to waiting.
  await submitCards(gambler!, pick)

  // The other non-czar still has to submit for the round to resolve.
  const other = players.find((p) => p !== curCzar && p !== gambler) as PlayerHandle
  await submitCards(other, pick)

  await waitForPhase(players, 'judging')
  await startReveal(curCzar)
  // A wager creates three anonymous submissions; wait for every reveal
  // before the Czar sends a command now that judging is phase-gated.
  await expect(curCzar.page.locator('.flip-reveal .card-response')).toHaveCount(3 * pick)
  await pickWinner(curCzar, 0)

  // Round resolved — the next round starts after ROUND_RESULT_PAUSE_MS.
  // hasGambled resets via round_started. We only assert the game moved
  // past the wager round — who wins is not the subject of this spec.
  await expect.poll(() => readRound(), { timeout: 20_000 }).toBeGreaterThan(roundBefore)

  await Promise.all(players.map((h) => h.context.close()))
})
