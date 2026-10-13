import { expect, test } from '@playwright/test'
import { createGame, joinGame } from '../helpers'

for (const route of ['lobby', 'session']) {
  test(`restoring a departed session on ${route} clears it and returns home`, async ({
    browser,
  }) => {
    const { handle: host, roomCode } = await createGame(browser, 'Host')
    const guest = await joinGame(browser, 'Guest', roomCode)
    try {
      const saved = await guest.page.evaluate(() => localStorage.getItem('cab_session'))
      expect(saved).not.toBeNull()
      await guest.page.getByRole('button', { name: 'Leave', exact: true }).click()
      await expect(guest.page).toHaveURL(/\/$/)
      await guest.page.evaluate((raw) => localStorage.setItem('cab_session', raw!), saved)
      await guest.page.goto(`/games/${roomCode}/${route}`)
      await expect(guest.page).toHaveURL(/\/$/)
      expect(await guest.page.evaluate(() => localStorage.getItem('cab_session'))).toBeNull()
      await expect(guest.page.getByRole('button', { name: 'Create a game' })).toBeVisible()
    } finally {
      await Promise.all([host, guest].map((player) => player.context.close()))
    }
  })
}
