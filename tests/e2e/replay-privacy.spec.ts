import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { SESSION_RECORDING_PRIVACY } from '../../src/lib/card-privacy'
import { seedReplayStats } from '../fixtures/replay-stats'

const require = createRequire(import.meta.url)
const recorderPath = join(dirname(require.resolve('posthog-js')), 'recorder.js')

// Exercise the actual rrweb serializer shipped with our PostHog SDK. Capture
// its initial DOM snapshot before network transport/compression so assertions
// don't depend on a live analytics project or remote recording configuration.
async function recordingSnapshot(page: Page): Promise<string> {
  await page.addScriptTag({ path: recorderPath })
  return page.evaluate((privacy) => {
    const recorder = window as typeof window & {
      rrweb: {
        record: (options: {
          maskAllInputs: boolean
          maskTextSelector: string
          emit: (event: { type: number; data: unknown }) => void
        }) => () => void
      }
    }
    let snapshot = ''
    const stop = recorder.rrweb.record({
      ...privacy,
      emit: (event) => {
        if (event.type === 2) snapshot = JSON.stringify(event.data)
      },
    })
    stop()
    if (!snapshot) throw new Error('PostHog recorder did not capture a DOM snapshot')
    return snapshot
  }, SESSION_RECORDING_PRIVACY)
}

test('Stats card text is redacted in replay while counts and navigation remain usable', async ({
  page,
  request,
}) => {
  const fixture = await seedReplayStats()
  try {
    const response = await request.get('/api/stats')
    expect(response.ok()).toBe(true)
    const stats = (await response.json()) as { topCards: { text: string; count: number }[] }
    expect(stats.topCards.slice(0, 2)).toEqual(fixture.topCards)

    // A fresh browser context has no cached Stats response. The screen fetches
    // the real API, which currently computes aggregates directly from Postgres.
    await page.goto('/stats')
    const cardTexts = fixture.topCards.map((card) => card.text)
    await expect(page.locator('.top-card-text').first()).toHaveText(cardTexts[0]!)
    await expect(page.locator('.top-card-text').nth(1)).toHaveText(cardTexts[1]!)
    const renderedCards = await page.locator('.top-card-text').allTextContents()
    expect(renderedCards.length).toBeGreaterThanOrEqual(2)
    await expect(page.locator('.top-card-text[data-ph-no-capture]')).toHaveCount(
      renderedCards.length,
    )

    const snapshot = await recordingSnapshot(page)
    for (const text of renderedCards) expect(snapshot).not.toContain(text)
    expect(snapshot).toContain('Most-picked response cards')
    expect(snapshot).toContain(`"textContent":"${fixture.topCards[0]!.count}"`)
    expect(snapshot).toContain('Back')

    await page.getByRole('button', { name: '← Back' }).click()
    await expect(page).toHaveURL(/\/$/)
  } finally {
    await fixture.cleanup()
  }
})

test('prompt blanks, filled prompts, hand cards, submissions and card backs are masked', async ({
  page,
}) => {
  // Render the production components at the DOM seam with tsx, since
  // Playwright's JSX transform creates component-test descriptors rather than
  // React elements. Nested prompt spans/underlines must inherit the mask.
  const markup = execFileSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../fixtures/replay-cards.ts', import.meta.url))],
    { encoding: 'utf8' },
  )
  await page.setContent(markup)
  await expect(page.locator('.card-text')).toHaveCount(6)
  await expect(page.locator('.card-text[data-ph-no-capture]')).toHaveCount(6)
  await expect(page.locator('.card-back-mark[data-ph-no-capture]')).toHaveCount(1)
  await expect(page.locator('.card-prompt .card-text').nth(1)).toContainText('Secret first fill')
  await expect(page.locator('.hand-dock .pick-order-badge')).toHaveText('1')

  const snapshot = await recordingSnapshot(page)
  // Every prompt/fill/response above includes this canary; one leaked surface
  // fails the assertion, including text nested below the privacy marker.
  expect(snapshot).not.toContain('Secret')
  expect(snapshot).not.toContain('CardsAgainstBhayanak')
  expect(snapshot).toContain('******')
  expect(snapshot).toContain('Your hand')
  expect(snapshot).toContain('Pick 1 more')
  expect(snapshot).toContain('Reveal')
})
