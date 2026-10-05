import { test, expect } from '@playwright/test'
import { createGame, joinGame } from '../helpers'

test('in-game Leave removes the player from the live roster and invalidates the old session', async ({
  browser,
}) => {
  const { handle: host, roomCode } = await createGame(browser, 'Host')
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)
  const carol = await joinGame(browser, 'Carol', roomCode)
  const players = [host, alice, bob, carol]
  try {
    await expect(host.page.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled()
    await host.page.getByRole('button', { name: 'Start game', exact: true }).click()
    await Promise.all(players.map((p) => p.page.waitForURL('**/session')))
    await expect(host.page.locator('.score-name', { hasText: 'Alice' })).toBeVisible()
    const oldSession = await alice.page.evaluate(() => localStorage.getItem('cab_session'))
    expect(oldSession).not.toBeNull()

    await alice.page.getByRole('button', { name: 'Leave', exact: true }).click()
    await alice.page.waitForURL((url) => url.pathname === '/', { timeout: 5000 })
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBeNull()
    for (const remaining of [host, bob, carol]) {
      await expect(remaining.page.locator('.score-name', { hasText: 'Alice' })).toHaveCount(0)
      await expect(remaining.page.locator('.score-name')).toHaveCount(3)
    }
    await alice.page.reload()
    await expect(alice.page).toHaveURL(/\/$/)
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBeNull()

    // Even restoring the old browser session cannot reconnect a departed player.
    await alice.page.evaluate((saved) => localStorage.setItem('cab_session', saved!), oldSession)
    await alice.page.goto(`/games/${roomCode}/lobby`)
    await alice.page.waitForURL((url) => url.pathname === '/')
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBeNull()
    await expect(host.page.locator('.score-name')).toHaveCount(3)
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})

test('lobby Leave keeps the session while pending or rejected and permits a confirmed retry', async ({
  browser,
}) => {
  const { handle: host, roomCode } = await createGame(browser, 'Host')
  const alice = await joinGame(browser, 'Alice', roomCode)
  let rejectLeave!: () => void
  const rejected = new Promise<void>((resolve) => {
    rejectLeave = resolve
  })
  const endpoint = `**/api/games/${roomCode}/leave`
  await alice.page.route(endpoint, async (route) => {
    await rejected
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable' })
  })
  try {
    const oldSession = await alice.page.evaluate(() => localStorage.getItem('cab_session'))
    await alice.page.getByRole('button', { name: 'Leave', exact: true }).click()
    await expect(alice.page.getByRole('button', { name: 'Leaving…', exact: true })).toBeDisabled()
    await expect(alice.page).toHaveURL(new RegExp(`/games/${roomCode}/lobby$`))
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBe(oldSession)
    await expect(host.page.locator('.player-name', { hasText: 'Alice' })).toBeVisible()

    rejectLeave()
    await expect(alice.page.getByRole('alert')).toHaveText(
      'Could not confirm leaving the game. Please try again.',
    )
    await expect(alice.page.getByRole('button', { name: 'Leave', exact: true })).toBeEnabled()
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBe(oldSession)
    await expect(alice.page).toHaveURL(new RegExp(`/games/${roomCode}/lobby$`))
    await expect(host.page.locator('.player-name', { hasText: 'Alice' })).toBeVisible()

    await alice.page.unroute(endpoint)
    await alice.page.getByRole('button', { name: 'Leave', exact: true }).click()
    await alice.page.waitForURL((url) => url.pathname === '/')
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBeNull()
    await expect(host.page.locator('.player-name', { hasText: 'Alice' })).toHaveCount(0)
  } finally {
    rejectLeave()
    await Promise.all([host, alice].map((p) => p.context.close()))
  }
})

test('in-game Leave shows a network failure and keeps the player in the game until retry succeeds', async ({
  browser,
}) => {
  const { handle: host, roomCode } = await createGame(browser, 'Host')
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)
  const carol = await joinGame(browser, 'Carol', roomCode)
  const players = [host, alice, bob, carol]
  try {
    await expect(host.page.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled()
    await host.page.getByRole('button', { name: 'Start game', exact: true }).click()
    await Promise.all(players.map((p) => p.page.waitForURL('**/session')))
    await expect(host.page.locator('.score-name', { hasText: 'Alice' })).toBeVisible()
    const oldSession = await alice.page.evaluate(() => localStorage.getItem('cab_session'))
    const endpoint = `**/api/games/${roomCode}/leave`
    await alice.page.route(endpoint, (route) => route.abort('failed'))

    await alice.page.getByRole('button', { name: 'Leave', exact: true }).click()
    await expect(alice.page.getByRole('alert')).toHaveText(
      'Could not confirm leaving the game. Please try again.',
    )
    await expect(alice.page).toHaveURL(new RegExp(`/games/${roomCode}/session$`))
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBe(oldSession)
    await expect(host.page.locator('.score-name', { hasText: 'Alice' })).toBeVisible()

    await alice.page.unroute(endpoint)
    await alice.page.getByRole('button', { name: 'Leave', exact: true }).click()
    await alice.page.waitForURL((url) => url.pathname === '/')
    expect(await alice.page.evaluate(() => localStorage.getItem('cab_session'))).toBeNull()
    await expect(host.page.locator('.score-name', { hasText: 'Alice' })).toHaveCount(0)
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})
