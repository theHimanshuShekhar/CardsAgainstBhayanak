import { test, expect } from '@playwright/test'
import { createGame, joinGame } from '../helpers'

test('player joins mid-game and enters queued state', async ({ browser }) => {
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 5 })
  const p1 = await joinGame(browser, 'Alice', roomCode)
  const p2 = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // While game is active, a 4th player joins
  const latecomer = await joinGame(browser, 'Latecomer', roomCode)

  // Latecomer should land on lobby (queued) or session with a queued status message
  await latecomer.page.waitForURL(/\/(lobby|session)/, { timeout: 15_000 })

  // Lobby: queued indicator, OR session: they get a hand next round
  // Either way, they should not see a hand dock immediately (they're queued)
  const handDock = latecomer.page.locator('.hand-dock')
  const isImmediatelyActive = await handDock.isVisible({ timeout: 3_000 }).catch(() => false)
  expect(isImmediatelyActive).toBe(false)

  await Promise.all([host, p1, p2, latecomer].map((h) => h.context.close()))
})

test('spectator can join mid-game and see the session', async ({ browser }) => {
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 5 })
  const p1 = await joinGame(browser, 'Alice', roomCode)
  const p2 = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all([host, p1, p2].map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  const spectator = await joinGame(browser, 'Watcher', roomCode, 'spectator')
  await spectator.page.waitForURL(/\/session/, { timeout: 15_000 })

  // Spectator should see the game but no hand dock
  await expect(spectator.page.locator('.game-wrap')).toBeVisible()
  await expect(spectator.page.locator('.hand-dock')).not.toBeVisible()

  await Promise.all([host, p1, p2, spectator].map((h) => h.context.close()))
})
