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

// Slice 1: Happy Ending — host triggers the forced "Make a Haiku" final.
//
// The HostMenu (⋯) only renders for the host. Clicking "End game" emits
// `happy_ending`; the engine queues the Haiku black card at the deck head
// and arms a final round. The current round still completes normally —
// the *next* round draws the Haiku prompt.

test('Happy Ending — host triggers forced Haiku final round', async ({ browser }) => {
  test.setTimeout(120_000)
  const { handle: host, roomCode } = await createGameWithRule(browser, 'Host', 'Happy Ending', {
    roundsToWin: 10,
  })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // The hand-dock only mounts once round_started has been received over
  // WS — a reliable signal that auth_ok landed and the connection is
  // ready. Without this, the host can race the WS handshake on a slow
  // CI box; pre-auth sends are now queued (useGameSocket) but waiting
  // here also keeps the test's intent legible.
  await Promise.race(
    players.map((h) =>
      h.page.locator('.hand-dock, .judge-bar').first().waitFor({ timeout: 20_000 }),
    ),
  )

  // Only the host renders the HostMenu trigger.
  await expect(host.page.locator('[data-testid="host-menu"]')).toBeVisible({ timeout: 10_000 })
  await expect(alice.page.locator('[data-testid="host-menu"]')).toBeHidden()
  await expect(bob.page.locator('[data-testid="host-menu"]')).toBeHidden()

  // Open the menu and arm Happy Ending.
  await host.page.locator('[data-testid="host-menu"]').click()
  await host.page.locator('[data-testid="end-early-btn"]').click()

  // The current round must finish normally before the Haiku is drawn.
  const czar = await getCzar(players)
  const others = players.filter((p) => p !== czar)
  const pick = await handPickCount(others[0]!)
  for (const p of others) await submitCards(p, pick)
  await waitForPhase(players, 'judging')
  await startReveal(czar)
  await pickWinner(czar, 0)

  // The next round's prompt reads "Make a Haiku."
  await expect(host.page.locator('.card-prompt')).toContainText('Make a Haiku', { timeout: 30_000 })

  await Promise.all(players.map((h) => h.context.close()))
})
