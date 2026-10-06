import { test, expect } from '@playwright/test'

test('initial rate-limited synchronization retries on the same socket and restores the lobby', async ({
  browser,
}) => {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const NativeSocket = window.WebSocket
    const counts = { sockets: 0, rejoins: 0 }
    ;(window as unknown as { syncCounts: typeof counts }).syncCounts = counts
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        counts.sockets++
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const message = JSON.parse(String(data))
        if (message.type === 'rejoin' && ++counts.rejoins === 1) {
          setTimeout(
            () =>
              this.dispatchEvent(
                new MessageEvent('message', {
                  data: JSON.stringify({
                    type: 'error',
                    code: 'rate_limited',
                    message: 'Retry snapshot',
                    retryAfterMs: 150,
                  }),
                }),
              ),
            0,
          )
          return
        }
        super.send(data)
      }
    }
  })
  try {
    const page = await context.newPage()
    await page.goto('/games/create')
    await page.getByLabel('Your handle').fill('RetryHost')
    await page.getByRole('button', { name: /Create lobby/i }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { syncCounts: { rejoins: number } }).syncCounts.rejoins,
        ),
      )
      .toBe(2)
    await expect(page.locator('.player-name').filter({ hasText: 'RetryHost' })).toBeVisible()
    expect(
      await page.evaluate(
        () => (window as unknown as { syncCounts: { sockets: number } }).syncCounts.sockets,
      ),
    ).toBe(1)
  } finally {
    await context.close()
  }
})
