import type { Browser, BrowserContext, Page } from '@playwright/test'

export type PlayerHandle = {
  context: BrowserContext
  page: Page
  username: string
  roomCode?: string
  playerId?: string
}

export async function createGame(
  browser: Browser,
  username: string,
  opts: { roundsToWin?: number; maxPlayers?: number } = {},
): Promise<{ handle: PlayerHandle; roomCode: string }> {
  const context = await browser.newContext()
  const page = await context.newPage()

  // Set stable anonId
  await page.addInitScript((name) => {
    localStorage.setItem('cab_anon_id', `anon-${name.toLowerCase()}`)
  }, username)

  await page.goto('/games/create')
  await page.fill('input[placeholder*="handle"]', username)

  if (opts.roundsToWin !== undefined) {
    // Adjust via stepper buttons — default is 8, click − to reduce
    const current = 8
    const diff = opts.roundsToWin - current
    const btn =
      diff > 0
        ? page.locator('.stepper-btn:last-child').nth(1)
        : page.locator('.stepper-btn:first-child').nth(1)
    for (let i = 0; i < Math.abs(diff); i++) await btn.click()
  }

  await page.click('button:has-text("Create lobby")')
  await page.waitForURL('**/lobby')

  const url = page.url()
  const codeMatch = /\/games\/([A-Z0-9]{6})\/lobby/.exec(url)
  const roomCode = codeMatch?.[1] ?? ''

  return { handle: { context, page, username, roomCode }, roomCode }
}

export async function joinGame(
  browser: Browser,
  username: string,
  roomCode: string,
  role: 'player' | 'spectator' = 'player',
): Promise<PlayerHandle> {
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.addInitScript((name) => {
    localStorage.setItem('cab_anon_id', `anon-${name.toLowerCase()}`)
  }, username)

  await page.goto('/games/join')
  await page.fill('input[placeholder*="code"]', roomCode)
  await page.fill('input[placeholder*="handle"]', username)

  if (role === 'spectator') {
    await page.click('button:has-text("Spectator")')
  }

  await page.click('button:has-text("Join game")')
  await page.waitForURL('**/lobby')

  return { context, page, username, roomCode }
}

// Waits until all players' pages show the expected phase indicator
export async function waitForPhase(players: PlayerHandle[], phase: string): Promise<void> {
  const indicators: Record<string, string> = {
    picking: '.hand-dock',
    waiting: '.hand-dock',
    judging: '.subs-grid',
    reveal: '.flip-reveal, .hidden-card',
    transition: 'text=Next round starting',
  }
  const selector = indicators[phase] ?? `.phase-${phase}`
  // At least one non-czar player will see the phase indicator
  await Promise.race(players.map((h) => h.page.waitForSelector(selector, { timeout: 30_000 })))
}

// Returns the handle whose page shows the "judge-bar" or no hand dock (i.e. they're the Czar)
export async function getCzar(players: PlayerHandle[]): Promise<PlayerHandle> {
  for (const h of players) {
    const hasJudgeBar = await h.page
      .locator('.judge-bar')
      .isVisible()
      .catch(() => false)
    const hasHandDock = await h.page
      .locator('.hand-dock')
      .isVisible()
      .catch(() => false)
    if (hasJudgeBar || !hasHandDock) return h
  }
  return players[0]!
}

// Submit N cards for a non-czar player (clicks first N available hand cards)
export async function submitCards(handle: PlayerHandle, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await handle.page.locator('.hand-card-wrap').nth(i).click()
  }
  await handle.page.click('button:has-text("Submit")')
}

// Czar clicks "Start reveal" button
export async function startReveal(czar: PlayerHandle): Promise<void> {
  const btn = czar.page.locator('button:has-text("Start reveal")')
  if (await btn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await btn.click()
  } else {
    // Server-controlled reveal — nothing to click
  }
}

// Czar picks winner at given index (clicks first visible response card in that submission slot)
export async function pickWinner(czar: PlayerHandle, index: number): Promise<void> {
  await czar.page.locator('.flip-reveal').nth(index).locator('.card-response').click()
}
