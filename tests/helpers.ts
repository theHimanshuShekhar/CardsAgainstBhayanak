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
  await page.getByLabel('Your handle').fill(username)

  if (opts.roundsToWin !== undefined) {
    // Read the live value and converge — the create UI's default has drifted
    // before (S2 rebuild changed it 8→7); a hardcoded delta over-clicks into
    // the disabled stepper bound and hangs.
    const stepper = page.locator('.opt-row', { hasText: 'Rounds to win' }).locator('.stepper')
    const valEl = stepper.locator('.stepper-val')
    for (let guard = 0; guard < 25; guard++) {
      const cur = parseInt((await valEl.textContent())?.trim() ?? '', 10)
      if (cur === opts.roundsToWin) break
      const btn =
        cur > opts.roundsToWin
          ? stepper.locator('.stepper-btn').first()
          : stepper.locator('.stepper-btn').last()
      await btn.click()
    }
  }

  // The Create lobby button is gated by `canStart` (username ≥ 2 chars
  // AND ≥ 1 pack). The Core pack auto-selects from a useEffect after
  // /api/packs resolves, so racing the click before that effect lands
  // hits a disabled button. Wait for it to enable.
  const createBtn = page.locator('button:has-text("Create lobby")')
  await createBtn.waitFor({ state: 'visible' })
  await page
    .waitForFunction(
      () =>
        !document
          .querySelector<HTMLButtonElement>('button:disabled')
          ?.textContent?.includes('Create lobby'),
      null,
      { timeout: 15_000 },
    )
    .catch(async () => {
      // Fallback: poll the enabled state directly. waitForFunction can
      // miss across SSR→hydration on slow CI.
      for (let i = 0; i < 30; i++) {
        if (await createBtn.isEnabled()) return
        await page.waitForTimeout(500)
      }
    })
  await createBtn.click()
  await page.waitForURL('**/lobby')

  const url = page.url()
  const codeMatch = /\/games\/([A-Z0-9]{6})\/lobby/.exec(url)
  const roomCode = codeMatch?.[1] ?? ''

  return { handle: { context, page, username, roomCode }, roomCode }
}

// Creates a game with a single house-rule pre-selected before clicking
// "Create lobby". The rule is identified by its visible CheckCard title
// (e.g. "Rebooting the Universe", "Happy Ending"). Returns the host
// handle and resolved room code, same shape as createGame.
export async function createGameWithRule(
  browser: Browser,
  username: string,
  ruleTitle: string,
  opts: { roundsToWin?: number; maxPlayers?: number } = {},
): Promise<{ handle: PlayerHandle; roomCode: string }> {
  const context = await browser.newContext()
  const page = await context.newPage()

  await page.addInitScript((name) => {
    localStorage.setItem('cab_anon_id', `anon-${name.toLowerCase()}`)
  }, username)

  await page.goto('/games/create')
  await page.getByLabel('Your handle').fill(username)

  if (opts.roundsToWin !== undefined) {
    const stepper = page.locator('.opt-row', { hasText: 'Rounds to win' }).locator('.stepper')
    const valEl = stepper.locator('.stepper-val')
    for (let guard = 0; guard < 25; guard++) {
      const cur = parseInt((await valEl.textContent())?.trim() ?? '', 10)
      if (cur === opts.roundsToWin) break
      const btn =
        cur > opts.roundsToWin
          ? stepper.locator('.stepper-btn').first()
          : stepper.locator('.stepper-btn').last()
      await btn.click()
    }
  }

  // Toggle the rule's CheckCard. Title-match is sufficient — rule titles
  // are unique within the editor.
  const ruleCard = page.locator('.check-card', { hasText: ruleTitle }).first()
  await ruleCard.waitFor({ state: 'visible' })
  await ruleCard.click()

  // The Create lobby button is gated by `canStart` (username ≥ 2 chars
  // AND ≥ 1 pack). The Core pack auto-selects from a useEffect after
  // /api/packs resolves, so racing the click before that effect lands
  // hits a disabled button. Wait for it to enable.
  const createBtn = page.locator('button:has-text("Create lobby")')
  await createBtn.waitFor({ state: 'visible' })
  await page
    .waitForFunction(
      () =>
        !document
          .querySelector<HTMLButtonElement>('button:disabled')
          ?.textContent?.includes('Create lobby'),
      null,
      { timeout: 15_000 },
    )
    .catch(async () => {
      // Fallback: poll the enabled state directly. waitForFunction can
      // miss across SSR→hydration on slow CI.
      for (let i = 0; i < 30; i++) {
        if (await createBtn.isEnabled()) return
        await page.waitForTimeout(500)
      }
    })
  await createBtn.click()
  await page.waitForURL('**/lobby')

  const codeMatch = /\/games\/([A-Z0-9]{6})\/lobby/.exec(page.url())
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
  await page.getByLabel('Room code').fill(roomCode)
  await page.getByLabel('Your handle').fill(username)

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

// Returns the Czar handle. Polls until the round is fully rendered — the
// Czar's page shows no hand dock while every other player's does — so a
// mid-transition snapshot can't mistake a not-yet-rendered non-Czar for
// the Czar.
export async function getCzar(players: PlayerHandle[]): Promise<PlayerHandle> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const docks = await Promise.all(
      players.map((h) =>
        h.page
          .locator('.hand-dock')
          .isVisible()
          .catch(() => false),
      ),
    )
    const without = players.filter((_, i) => !docks[i])
    if (without.length === 1 && docks.filter(Boolean).length === players.length - 1)
      return without[0]!
    await players[0]!.page.waitForTimeout(300)
  }
  // Fallback: judge-bar holder, else first dock-less player.
  for (const h of players) {
    const hasJudgeBar = await h.page
      .locator('.judge-bar')
      .isVisible()
      .catch(() => false)
    if (hasJudgeBar) return h
  }
  return players[0]!
}

// Reads the pick count for the current black card from a non-Czar's hand
// dock label ("Your hand · pick one" → 1, "pick 2 in order" → 2).
export async function handPickCount(handle: PlayerHandle): Promise<number> {
  const eyebrow = handle.page.locator('.hand-dock .eyebrow')
  await eyebrow.waitFor({ state: 'visible', timeout: 15_000 })
  const txt = (await eyebrow.textContent()) ?? ''
  const m = /pick (\d+)/i.exec(txt)
  return m ? Number(m[1]) : 1
}

// Plays one round to completion at the given pick count: each non-Czar
// submits `pick` cards, the Czar reveals (server-driven) and picks the
// first submission. Leaves the game at the next round's picking phase.
export async function playRound(players: PlayerHandle[], pick: number): Promise<void> {
  const czar = await getCzar(players)
  for (const p of players.filter((pl) => pl !== czar)) await submitCards(p, pick)
  await waitForPhase(players, 'judging')
  await pickWinner(czar, 0)
}

// Submit N cards for a non-czar player (selects first N hand cards, submits).
// The hand is a flat horizontally scrollable flex row at every breakpoint
// (`.hand` = `display: flex; gap: 10px`), so adjacent cards don't overlap
// and real `.click()` would work. We keep `dispatchEvent('click')` here
// for historical consistency across the 50+ specs that depend on this
// helper (firing on the exact target node bypasses hit-testing entirely
// — equivalent to a forced click on the lifted card, with no risk of a
// regression if hover/select lift ever exceeds the gap again). See
// `tests/e2e/ui-golden-path.spec.ts` for the real-click variant.
export async function submitCards(handle: PlayerHandle, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const card = handle.page.locator('.hand-card-wrap').nth(i).locator('.card-response')
    await card.waitFor({ state: 'visible' })
    await card.dispatchEvent('click')
  }
  const submit = handle.page.locator('.hand-dock-hd button')
  await submit.waitFor({ state: 'visible' })
  await submit.dispatchEvent('click')
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
