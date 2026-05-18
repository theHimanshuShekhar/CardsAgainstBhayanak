import { test, expect } from '@playwright/test'

// posthog-js loads its staff-only editing/debug toolbar from one of two
// triggers: a `#__posthog`/`#state` URL hash, or a persisted token in
// localStorage `_postHogToolbarParams`. Once a PostHog project member
// launches the toolbar on a domain, posthog-js persists that token, so the
// toolbar silently re-appears for that browser on every later visit — what
// surfaced as "the toolbar is showing on the prod site". posthog-js 1.373.x
// has no flag to disable only the toolbar, so on the deployed site we strip
// both triggers before posthog.init() (init() reads the localStorage
// trigger at call time). This asserts that contract: with PostHog enabled
// and both triggers pre-seeded, after load the localStorage trigger is gone
// and the hash trigger is stripped.
//
// Uses 127.0.0.1 so `location.hostname !== 'localhost'` (the prod guard;
// local dev intentionally keeps the toolbar). `/api/config` is stubbed so
// the code path runs without a real PostHog project — the deployed env's
// key is intentionally absent in tests.
test('PostHog toolbar triggers are cleared on the deployed site', async ({ page }) => {
  await page.route('**/api/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        posthogKey: 'phc_test_dummy',
        posthogHost: 'https://us.i.posthog.com',
      }),
    }),
  )

  // The persisted toolbar token — the real-world cause of it re-showing on
  // every visit — seeded before any app script runs.
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        '_postHogToolbarParams',
        JSON.stringify({ token: 'fake', actionId: null }),
      )
    } catch {
      /* storage may be unavailable */
    }
  })

  // Land with the hash trigger present too, on the prod host.
  await page.goto('http://127.0.0.1:3000/#__posthog=%7B%22token%22%3A%22fake%22%7D')

  // initPostHog() awaits /api/config, then clears both triggers before init.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('_postHogToolbarParams')), {
      timeout: 10_000,
    })
    .toBeNull()

  expect(await page.evaluate(() => location.hash), 'toolbar hash stripped').toBe('')
})
