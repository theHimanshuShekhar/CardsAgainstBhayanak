import { test, expect } from '@playwright/test'
import { HANDLES } from '../fixtures/handles'
import { createGame, joinGame, getCzar, waitForPhase } from '../helpers'

// Regression: on desktop the Submit button + "Your hand" label live in
// `.hand-dock-hd`, a non-positioned element with no z-index, directly above
// the fanned `.hand`. Each `.hand-card-wrap` has a `transform` (own stacking
// context) plus `z-index` 0..9 (100 hover / 99 selected). A `.card-md` is
// 280px tall in a 200px `.hand` (align-items:flex-end), so cards overflow
// ~80px up and — being transformed/z-indexed — paint OVER the whole header
// band. The entire header (label + Submit) renders behind the hand, so
// players cannot submit.
//
// The rest of the suite hides this: helpers.ts `submitCards()` uses
// `dispatchEvent('click')` to bypass hit-testing. Here we assert the header
// is on top: at every sampled point of the Submit button's box, the topmost
// element must be the button (or inside `.hand-dock-hd`), never a hand card.
test('round 1 Submit button is not hidden behind the hand', async ({ browser }) => {
  test.setTimeout(90_000)
  const { handle: host, roomCode } = await createGame(browser, HANDLES[0], { roundsToWin: 3 })
  const p1 = await joinGame(browser, HANDLES[1], roomCode)
  const p2 = await joinGame(browser, HANDLES[2], roomCode)
  const all = [host, p1, p2]

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')
  await Promise.all(all.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))
  await waitForPhase(all, 'picking')

  const czar = await getCzar(all)
  const player = all.find((h) => h !== czar)!
  const page = player.page

  // Documented desktop breakpoint (fanned hand, > 1100px).
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator('.hand-dock-hd button').waitFor({ state: 'visible', timeout: 15_000 })
  // Let the staggered deal animation (≈0.6s delay + 0.55s) fully settle so
  // cards reach their final, header-overlapping resting position, and clear
  // any :hover (raises a card to z-index 100).
  await page.mouse.move(2, 2)
  await page.waitForTimeout(2000)

  const occluders = await page.evaluate(() => {
    const btn = document.querySelector('.hand-dock-hd button') as HTMLElement | null
    if (!btn) return ['no-button']
    const r = btn.getBoundingClientRect()
    const hits: string[] = []
    for (let fy = 0.15; fy <= 0.85; fy += 0.175) {
      for (let fx = 0.1; fx <= 0.9; fx += 0.1) {
        const x = r.left + r.width * fx
        const y = r.top + r.height * fy
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        if (!el) continue
        if (btn.contains(el) || el.closest('.hand-dock-hd')) continue
        if (el.closest('.hand')) {
          hits.push(
            `(${fx.toFixed(2)},${fy.toFixed(2)})→${el.closest('.hand-card-wrap') ? 'card' : el.className}`,
          )
        }
      }
    }
    return hits
  })

  expect(occluders, `hand cards painting over the Submit button: ${occluders.join(', ')}`).toEqual(
    [],
  )

  await Promise.all(all.map((h) => h.context.close()))
})
