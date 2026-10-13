import { expect, test } from '@playwright/test'

test('invalid saved JSON recovers to a usable join form', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('cab_session', '{broken'))
  await page.goto('/games/ABCDEF/lobby')
  await expect(page).toHaveURL(/\/games\/join/)
  await expect(page.getByRole('heading', { name: 'Enter the room' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Your handle' }).fill('Recovered')
  await page.getByRole('textbox', { name: 'Room code' }).fill('ABCDEF')
  await expect(page.getByRole('button', { name: 'Join game', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '← Back' }).click()
  await expect(page.getByRole('button', { name: 'Create a game' })).toBeVisible()
  expect(errors).toEqual([])
})

test('blocked storage recovers to join and allows joining without persistence', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const response = await request.post('/api/games', {
    data: {
      username: 'Host',
      anonId: 'storage-test-host',
      config: {
        maxPlayers: 6,
        roundsToWin: 3,
        timer: 'Off',
        packs: ['base'],
        rules: [],
      },
    },
  })
  expect(response.ok()).toBe(true)
  const { roomCode } = await response.json()
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage blocked', 'SecurityError')
      },
    })
  })
  await page.goto(`/games/${roomCode}/lobby`)
  await expect(page).toHaveURL(/\/games\/join/)
  await page.getByRole('textbox', { name: 'Your handle' }).fill('NoStorage')
  await page.getByRole('textbox', { name: 'Room code' }).fill(roomCode)
  await page.getByRole('button', { name: 'Join game', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/games/${roomCode}/lobby`))
  await expect(page.getByText(/NoStorageYOU/)).toBeVisible()
  await page.getByRole('button', { name: 'Leave', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Create a game' })).toBeVisible()
  await page.goto(`/games/${roomCode}/lobby`)
  await expect(page).toHaveURL(/\/games\/join/)
  expect(errors).toEqual([])
})

for (const [name, saved] of [
  ['null', 'null'],
  ['array', '[]'],
  ['wrong field types', JSON.stringify({ roomCode: 123, playerId: {}, role: 'player' })],
  [
    'unknown version',
    JSON.stringify({
      version: 2,
      roomCode: 'ABCDEF',
      playerId: 'p',
      sessionToken: 'token',
      username: 'Guest',
      role: 'player',
      anonId: 'anon',
    }),
  ],
  [
    'invalid role',
    JSON.stringify({
      roomCode: 'ABCDEF',
      playerId: 'p',
      sessionToken: 'token',
      username: 'Guest',
      role: 'host',
      anonId: 'anon',
    }),
  ],
] as const) {
  test(`${name} saved session recovers from a game route without render loops`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await page.addInitScript((raw) => localStorage.setItem('cab_session', raw), saved)
    await page.goto('/games/ABCDEF/lobby')
    await expect(page).toHaveURL(/\/games\/join/)
    await page.getByRole('textbox', { name: 'Your handle' }).fill('Recovered')
    await page.getByRole('button', { name: '← Back' }).click()
    await expect(page.getByRole('button', { name: 'Create a game' })).toBeVisible()
    expect(errors).toEqual([])
  })
}

for (const version of [undefined, 1]) {
  test(`valid ${version ? 'versioned' : 'legacy'} saved session reconnects after reload`, async ({
    page,
    request,
  }) => {
    const response = await request.post('/api/games', {
      data: {
        username: 'ReturningHost',
        anonId: 'returning-storage-host',
        config: {
          maxPlayers: 6,
          roundsToWin: 3,
          timer: 'Off',
          packs: ['base'],
          rules: [],
        },
      },
    })
    expect(response.ok()).toBe(true)
    const { roomCode, playerId, sessionToken } = await response.json()
    await page.addInitScript(
      (saved) => localStorage.setItem('cab_session', JSON.stringify(saved)),
      {
        version,
        roomCode,
        playerId,
        sessionToken,
        username: 'ReturningHost',
        role: 'player',
        anonId: 'returning-storage-host',
      },
    )
    await page.goto(`/games/${roomCode}/lobby`)
    await expect(page.getByText(/ReturningHostYOUHOST/)).toBeVisible()
    await page.reload()
    await expect(page.getByText(/ReturningHostYOUHOST/)).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/games/${roomCode}/lobby`))
  })
}

for (const route of ['session', 'end']) {
  test(`invalid saved session on ${route} recovers to join`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cab_session', '{}'))
    await page.goto(`/games/ABCDEF/${route}`)
    await expect(page).toHaveURL(/\/games\/join/)
    await expect(page.getByRole('heading', { name: 'Enter the room' })).toBeVisible()
  })
}
