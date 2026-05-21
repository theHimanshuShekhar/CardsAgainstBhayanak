import { test, expect } from '@playwright/test'
import {
  createGameWithRule,
  joinGame,
  submitCards,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// Slice 2: God Is Dead — no czar, every active player votes.
//
// Scope: this spec exercises the *UI wiring* — vote buttons appear on
// every page once reveal is done, the live vote_tally event propagates
// a chip bump to all clients, and the optimistic-disable locks the
// voter's own page after they tap. We deliberately don't drive the
// round to resolution: the engine silently drops self-votes
// (resolvePlayerId(votedKey) === voterId → return), so a 3-player
// round stalls any time a submitter taps their own card. That stall is
// a product gap to address in another change, not something to retry
// around in a test.

test('God Is Dead — vote button mounts, tally chip propagates a vote', async ({ browser }) => {
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

  // Reveal completes when canVote flips → first vote button is enabled
  // (`canVote = revealIndex >= submissions.length`). All three clients
  // share the same server reveal sequence, so they enable at roughly the
  // same wall-clock moment — wait in parallel instead of serially so the
  // total budget is one stagger window, not three.
  await Promise.all(
    players.map((p) =>
      expect(p.page.locator('[data-testid="vote-btn"]').first()).toBeEnabled({
        timeout: 45_000,
      }),
    ),
  )

  // Every page renders one button + one tally chip per submission.
  for (const p of players) {
    await expect(p.page.locator('[data-testid="vote-btn"]')).toHaveCount(3)
    await expect(p.page.locator('[data-testid="vote-tally"]')).toHaveCount(3)
  }

  // All three players vote for the first submission. At most one of
  // them is the actual submitter of that card (self-vote → engine
  // silently drops); the other two clicks must land. Final tally on
  // card 0 across every client should be ≥ 2.
  for (const p of players) {
    await p.page.locator('[data-testid="vote-btn"]').first().click()
    // Optimistic disable on the clicker's own page.
    await expect(p.page.locator('[data-testid="vote-btn"]').first()).toBeDisabled({
      timeout: 5_000,
    })
  }

  // The tally chip on every client should report ≥ 2 votes for card 0.
  // We poll host's chip — vote_tally is broadcast, so any client works.
  const hostFirstTally = host.page.locator('[data-testid="vote-tally"]').first()
  await expect
    .poll(
      async () => {
        const t = (await hostFirstTally.textContent()) ?? ''
        return parseInt(t.trim().split(' ')[0] ?? '0', 10)
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2)

  await Promise.all(players.map((h) => h.context.close()))
})
