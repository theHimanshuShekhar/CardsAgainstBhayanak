import { test, expect } from '@playwright/test'

const MOBILE_VIEWPORTS = [
  { name: '375×667 (iPhone SE)', width: 375, height: 667 },
  { name: '414×896 (iPhone XR)', width: 414, height: 896 },
]

for (const vp of MOBILE_VIEWPORTS) {
  test(`home page renders correctly at ${vp.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await context.newPage()

    await page.goto('/')
    await expect(page.locator('h1, .home-title')).toBeVisible()
    await expect(page.locator('button:has-text("Create")')).toBeVisible()
    await expect(page.locator('button:has-text("Join")')).toBeVisible()

    await context.close()
  })

  test(`create page is usable at ${vp.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await context.newPage()

    await page.goto('/games/create')
    const handle = page.locator('input[placeholder*="handle"]')
    await expect(handle).toBeVisible()
    await handle.fill('MobileUser')

    // Stepper buttons should be tappable
    const steppers = page.locator('.stepper')
    if ((await steppers.count()) > 0) {
      const btn = steppers.first().locator('.stepper-btn').first()
      await expect(btn).toBeVisible()
    }

    await context.close()
  })

  test(`join page is usable at ${vp.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await context.newPage()

    await page.goto('/games/join')
    await expect(page.locator('input[placeholder*="code"]')).toBeVisible()
    await expect(page.locator('input[placeholder*="handle"]')).toBeVisible()

    await context.close()
  })
}
