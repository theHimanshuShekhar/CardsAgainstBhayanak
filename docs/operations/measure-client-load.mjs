// Run from a checkout with dev dependencies and Playwright Chromium installed.
// Each navigation owns a fresh context; cache and service workers are disabled.
import { chromium } from '@playwright/test'

const [base, ...paths] = process.argv.slice(2)
if (!base)
  throw new Error('Usage: node docs/operations/measure-client-load.mjs <base-url> [paths...]')
const origin = new URL(base).origin
const browser = await chromium.launch()
try {
  console.log(JSON.stringify({ browser: browser.version(), origin, samplesPerPath: 3 }))
  for (const path of paths.length ? paths : ['/']) {
    for (let sample = 1; sample <= 3; sample++) {
      const context = await browser.newContext({ serviceWorkers: 'block' })
      try {
        const page = await context.newPage()
        const session = await context.newCDPSession(page)
        await session.send('Network.enable')
        await session.send('Network.setCacheDisabled', { cacheDisabled: true })
        const requests = new Map()
        const failures = []
        const errors = []
        session.on('Network.responseReceived', ({ requestId, response, type }) => {
          requests.set(requestId, {
            url: response.url,
            type,
            status: response.status,
            encoding:
              response.headers['Content-Encoding'] ?? response.headers['content-encoding'] ?? null,
          })
        })
        session.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
          const request = requests.get(requestId)
          if (request) request.transferredBytes = encodedDataLength
        })
        page.on('requestfailed', (request) => {
          failures.push({ url: request.url(), error: request.failure()?.errorText })
        })
        page.on('pageerror', (error) => errors.push(error.message))
        const response = await page.goto(new URL(path, base).href, { waitUntil: 'networkidle' })
        await page.evaluate(() => document.fonts.ready)
        const navigation = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0]
          return { domContentLoadedMs: nav.domContentLoadedEventEnd, loadMs: nav.loadEventEnd }
        })
        const resources = [...requests.values()]
        const firstParty = resources.filter((request) => new URL(request.url).origin === origin)
        const assets = firstParty.filter((request) =>
          new URL(request.url).pathname.startsWith('/assets/'),
        )
        const bytes = (entries) =>
          entries.reduce((total, entry) => total + (entry.transferredBytes ?? 0), 0)
        console.log(
          JSON.stringify({
            path,
            sample,
            status: response?.status(),
            ...navigation,
            firstPartyTransferredBytes: bytes(firstParty),
            assetTransferredBytes: bytes(assets),
            externalTransferredBytes: bytes(
              resources.filter((request) => !firstParty.includes(request)),
            ),
            failures,
            errors,
            resources,
          }),
        )
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}
