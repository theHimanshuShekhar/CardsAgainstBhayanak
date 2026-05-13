import { test, expect } from '@playwright/test'
import { HANDLES } from '../fixtures/handles'
import { createGame, joinGame } from '../helpers'

test('6-player 5-win golden path', async ({ browser }) => {
  // Host creates game
  const { handle: host, roomCode } = await createGame(browser, HANDLES[0], {
    roundsToWin: 5,
    maxPlayers: 6,
  })

  // 5 other players join
  const players = await Promise.all(
    HANDLES.slice(1).map((name) => joinGame(browser, name, roomCode)),
  )
  const allHandles = [host, ...players]

  // All 6 land on lobby — wait for Start button to be enabled
  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })

  // Host starts game
  await host.page.click('button:has-text("Start game")')

  // All contexts navigate to session
  await Promise.all(allHandles.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Wait for game_over (driven by WS events auto-navigating to /end)
  await Promise.all(allHandles.map((h) => h.page.waitForURL('**/end', { timeout: 5 * 60 * 1_000 })))

  // Verify end screen visible for all
  for (const h of allHandles) {
    await expect(h.page.locator('body')).toBeVisible()
  }

  // Cleanup
  await Promise.all(allHandles.map((h) => h.context.close()))
})

test('join as spectator cannot submit cards', async ({ browser }) => {
  const { handle: host, roomCode } = await createGame(browser, 'HostUser', { roundsToWin: 3 })

  const player1 = await joinGame(browser, 'PlayerOne', roomCode)
  const player2 = await joinGame(browser, 'PlayerTwo', roomCode)
  const spectator = await joinGame(browser, 'Watcher', roomCode, 'spectator')

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  await Promise.all(
    [host, player1, player2, spectator].map((h) =>
      h.page.waitForURL('**/session', { timeout: 20_000 }),
    ),
  )

  // Spectator should not see a hand dock or submit button
  const submitBtn = spectator.page.locator('button:has-text("Submit")')
  await expect(submitBtn).not.toBeVisible()

  await Promise.all([host, player1, player2, spectator].map((h) => h.context.close()))
})
