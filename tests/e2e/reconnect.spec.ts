import { test, expect } from '@playwright/test'
import { createGame, joinGame } from '../helpers'
import { TIMING } from '../../src/lib/timing'

test('player refresh mid-picking reconnects with hand', async ({ browser }) => {
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 3 })
  const p1 = await joinGame(browser, 'Reconnector', roomCode)
  const p2 = await joinGame(browser, 'Stable', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Reload p1 mid-round
  await p1.page.reload()
  await p1.page.waitForURL('**/session', { timeout: 15_000 })

  // p1 should still see the session (not redirected home)
  expect(p1.page.url()).toContain('/session')

  await Promise.all([host, p1, p2].map((h) => h.context.close()))
})

test('player drop > grace window → removed from game', async ({ browser }) => {
  // Explicitly waits GRACE_WINDOW_MS (30s) + 5s; the 30s default test cap
  // cannot contain it. Matches full-game.spec's per-test timeout convention.
  test.setTimeout(75_000)
  const { handle: host, roomCode } = await createGame(browser, 'Host2', { roundsToWin: 3 })
  const p1 = await joinGame(browser, 'Dropper', roomCode)
  const p2 = await joinGame(browser, 'Stable2', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Close p1's connection without reconnecting
  await p1.context.close()

  // Wait for grace window to expire
  await host.page.waitForTimeout(TIMING.GRACE_WINDOW_MS + 5_000)

  // Game should still continue for remaining players
  expect(host.page.url()).toContain('/session')

  await Promise.all([host, p2].map((h) => h.context.close()))
})
