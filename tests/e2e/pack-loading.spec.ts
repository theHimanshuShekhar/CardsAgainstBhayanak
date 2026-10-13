import { test, expect } from '@playwright/test'

// Intercept only the browser's public HTTP boundary; successful retries and
// game creation use the real application, PostgreSQL and Redis.
test('pack loading recovers without losing game configuration', async ({ page }) => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    '**/api/packs',
    async (route) => {
      await pending
      await route.abort('failed')
    },
    { times: 1 },
  )
  await page.goto('/games/create')
  await expect(page.getByText('Loading card packs…')).toBeVisible()
  await page.getByRole('textbox', { name: 'Your handle' }).fill('retry_host')
  await page.getByRole('radio', { name: '90s', exact: true }).click()
  await page.locator('.check-card', { hasText: 'Packing Heat' }).click()
  await expect(page.getByRole('button', { name: 'Create lobby', exact: true })).toBeDisabled()
  release()
  await expect(page.getByText('Card packs could not be loaded. Please retry.')).toBeVisible()
  await page.getByRole('button', { name: 'Retry loading packs' }).click()
  await expect(page.locator('.check-card', { hasText: 'CAH Base Set' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Your handle' })).toHaveValue('retry_host')
  await expect(page.getByRole('radio', { name: '90s', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.locator('.check-card', { hasText: 'Packing Heat' })).toHaveClass(/on/)
  const creation = page.waitForResponse(
    (res) => res.url().endsWith('/api/games') && res.request().method() === 'POST',
  )
  await page.getByRole('button', { name: 'Create lobby', exact: true }).click()
  const response = await creation
  expect(response.status()).toBe(201)
  expect(response.request().postDataJSON()).toMatchObject({
    username: 'retry_host',
    config: { timer: '90s', rules: ['packing_heat'] },
  })
  await expect(page).toHaveURL(/\/games\/[A-Z0-9]+\/lobby/)
})

for (const failure of [
  { name: 'HTTP error despite valid JSON', status: 503, body: { packs: [] } },
  { name: 'missing catalog', status: 200, body: {} },
  {
    name: 'malformed pack',
    status: 200,
    body: { packs: [{ id: 'bad', name: 'Broken', slug: 'broken', cardCount: 'many' }] },
  },
  { name: 'invalid JSON', status: 200, body: '{' },
]) {
  test(`pack loading rejects ${failure.name} and offers recovery`, async ({ page }) => {
    await page.route(
      '**/api/packs',
      (route) =>
        route.fulfill({
          status: failure.status,
          contentType: 'application/json',
          body: typeof failure.body === 'string' ? failure.body : JSON.stringify(failure.body),
        }),
      { times: 1 },
    )
    await page.goto('/games/create')
    await page.getByRole('textbox', { name: 'Your handle' }).fill('catalog_host')
    await expect(page.getByText('Card packs could not be loaded. Please retry.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create lobby', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Retry loading packs' }).click()
    await expect(page.getByRole('button', { name: 'Create lobby', exact: true })).toBeEnabled()
  })
}

test('an empty pack catalog explains why creation is unavailable and can be retried', async ({
  page,
}) => {
  await page.route('**/api/packs', (route) => route.fulfill({ json: { packs: [] } }), { times: 1 })
  await page.goto('/games/create')
  await page.getByRole('textbox', { name: 'Your handle' }).fill('empty_host')
  await expect(
    page.getByText('No card packs are available yet. Please retry shortly.'),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create lobby', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Retry loading packs' }).click()
  await expect(page.getByRole('button', { name: 'Create lobby', exact: true })).toBeEnabled()
})
