import { test, expect } from '@playwright/test'
import { HANDLES } from '../fixtures/handles'
import { createGame, joinGame, getCzar, handPickCount, waitForPhase } from '../helpers'

// Responsive regression for the round-1 picking screen. Two real bugs lived
// here: (1) on desktop the fanned hand painted over the Submit button (own
// stacking context, no z-index on the header); (2) the locked 5:7 prompt
// card overflowed behind the sticky hand dock on any viewport < ~820px tall
// (every phone AND most laptops) with no way to see it at rest.
//
// For every screen size below, with the player in round-1 picking, assert:
//   - the hand is displayed (cards present, hand box visible),
//   - the Submit button is on top — at every sampled point of its box the
//     topmost element is the button or inside `.hand-dock-hd` (never a hand
//     card), i.e. a real pointer click would land on it, AND it is reachable
//     in the viewport,
//   - the prompt card is not occluded by the dock at the rest scroll
//     position (its sampled column resolves to the prompt, not the dock).
// Then prove end-to-end clickability with a real (non-dispatched) click.
const SIZES = [
  { name: 'desktop', w: 1280, h: 800 }, // fanned hand + short laptop height
  { name: 'laptop', w: 1366, h: 720 }, // common laptop viewport
  { name: 'iphone-se', w: 375, h: 667 }, // small phone
  { name: 'android-sm', w: 360, h: 640 }, // common small Android
  { name: 'fold', w: 280, h: 653 }, // narrowest realistic phone
]

test('round-1 hand + Submit + prompt render correctly across screen sizes', async ({ browser }) => {
  test.setTimeout(120_000)
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
  const pick = await handPickCount(player)

  // Let the staggered deal animation fully settle so cards reach their final
  // resting positions before any geometry is sampled.
  await page.locator('.hand-dock-hd button').waitFor({ state: 'visible', timeout: 15_000 })
  await page.mouse.move(1, 1)
  await page.waitForTimeout(2000)

  for (const s of SIZES) {
    await page.setViewportSize({ width: s.w, height: s.h })
    // Clear any :hover (raises a card to z-index 100) and reset the scroller
    // to the rest position the player actually sees first.
    await page.mouse.move(1, 1)
    await page.evaluate(() => {
      const sc = document.querySelector('.game-scene') as HTMLElement | null
      if (sc) sc.scrollTop = 0
    })
    await page.waitForTimeout(900)

    const r = await page.evaluate(() => {
      const out = {
        handCards: 0,
        handVisible: false,
        buttonInViewport: false,
        submitOccluders: [] as string[],
        promptOccluders: [] as string[],
      }
      const hand = document.querySelector('.hand') as HTMLElement | null
      out.handCards = document.querySelectorAll('.hand-card-wrap').length
      if (hand) {
        const hb = hand.getBoundingClientRect()
        out.handVisible = hb.width > 0 && hb.height > 0
      }

      // Submit button: sample a grid over its box. Topmost element must be
      // the button or inside the header band — never a hand card / overlay.
      const btn = document.querySelector('.hand-dock-hd button') as HTMLElement | null
      if (!btn) {
        out.submitOccluders.push('no-button')
      } else {
        const b = btn.getBoundingClientRect()
        for (let fy = 0.2; fy <= 0.8; fy += 0.3) {
          for (let fx = 0.15; fx <= 0.85; fx += 0.1) {
            const x = b.left + b.width * fx
            const y = b.top + b.height * fy
            if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue
            const el = document.elementFromPoint(x, y) as HTMLElement | null
            if (!el) continue
            if (btn.contains(el) || el.closest('.hand-dock-hd')) {
              out.buttonInViewport = true
              continue
            }
            out.submitOccluders.push(
              `(${fx.toFixed(2)},${fy.toFixed(2)})→${
                el.closest('.hand-card-wrap') ? 'card' : el.className || el.tagName
              }`,
            )
          }
        }
      }

      // Prompt: sample down its centre. Every on-screen point of the prompt's
      // own box must resolve to the prompt — nothing (dock/hand) on top.
      const prompt = document.querySelector('.card-prompt') as HTMLElement | null
      if (prompt) {
        const p = prompt.getBoundingClientRect()
        const cx = p.left + p.width / 2
        for (let y = p.top + 8; y < p.bottom - 8; y += 12) {
          if (y < 0 || y > window.innerHeight) continue
          const el = document.elementFromPoint(cx, y) as HTMLElement | null
          if (!el) continue
          if (el.closest('.card-prompt')) continue
          out.promptOccluders.push(
            `y=${Math.round(y - p.top)}→${
              el.closest('.hand-dock') ? 'dock' : el.className || el.tagName
            }`,
          )
        }
      } else {
        out.promptOccluders.push('no-prompt')
      }
      return out
    })

    const ctx = `[${s.name} ${s.w}x${s.h}]`
    expect(r.handVisible, `${ctx} hand box should be visible`).toBe(true)
    expect(r.handCards, `${ctx} hand should have cards`).toBeGreaterThanOrEqual(pick)
    expect(r.buttonInViewport, `${ctx} Submit button must be reachable in the viewport`).toBe(true)
    expect(
      r.submitOccluders,
      `${ctx} hand cards painting over the Submit button: ${r.submitOccluders.join(', ')}`,
    ).toEqual([])
    expect(
      r.promptOccluders,
      `${ctx} prompt occluded by the hand dock at rest: ${r.promptOccluders.join(', ')}`,
    ).toEqual([])
  }

  // End-to-end: a real pointer click (not dispatchEvent) on the Submit button
  // must register the submission. Selecting fanned cards still needs
  // dispatchEvent — that overlap is a separate, documented concern; the point
  // here is that the *button* itself is genuinely hit-testable and clickable.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.mouse.move(1, 1)
  await page.waitForTimeout(800)
  for (let i = 0; i < pick; i++) {
    const card = page.locator('.hand-card-wrap').nth(i).locator('.card-response')
    await card.waitFor({ state: 'visible' })
    await card.dispatchEvent('click')
  }
  const submit = page.locator('.hand-dock-hd button')
  await expect(submit).toBeEnabled()
  await submit.click() // real hit-tested click — fails if anything is on top
  await expect(
    player.page.locator('.hand-dock'),
    'submission registered, dock dismissed',
  ).toBeHidden({ timeout: 10_000 })

  await Promise.all(all.map((h) => h.context.close()))
})
