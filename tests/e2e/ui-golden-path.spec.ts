import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

// UI golden path: three real browsers play a full game start → win → rematch
// end-to-end through actual button clicks. No `wsClient`, no helpers/.ts
// shortcuts — every interaction is what a human would do. Small randomized
// waits between actions ("human pause") so the test surfaces races the
// speed-of-light protocol tests can't.
//
// Scope: this is intentionally a smoke + happy-path UI test. Edge cases
// (drops, gambles, voids) live in the rule-* and protocol specs.

type Handle = {
  context: BrowserContext
  page: Page
  name: string
}

// Mimic a real user's pacing between actions. Range chosen by feel: short
// enough that 3 rounds finish well under the test budget, long enough that
// click→commit races (e.g. double-submit) get a chance to surface.
async function humanPause(page: Page, min = 100, max = 400): Promise<void> {
  const ms = min + Math.floor(Math.random() * (max - min))
  await page.waitForTimeout(ms)
}

async function newHandle(browser: Browser, name: string): Promise<Handle> {
  const context = await browser.newContext()
  const page = await context.newPage()
  // Stable anonId per handle so server-side PostHog distinct IDs are reproducible.
  await page.addInitScript((n) => {
    localStorage.setItem('cab_anon_id', `anon-ui-${n.toLowerCase()}`)
  }, name)
  return { context, page, name }
}

// Host creates a game through the create-game form, sets roundsToWin via
// the stepper buttons, then clicks "Create lobby". Returns the room code
// parsed from /games/$code/lobby.
async function hostCreatesGame(host: Handle, roundsToWin: number): Promise<string> {
  await host.page.goto('/games/create')
  await humanPause(host.page)

  await host.page.getByLabel('Your handle').fill(host.name)
  await humanPause(host.page)

  // Converge the stepper to the target. Reads live value rather than
  // counting deltas: the default has drifted before (S2 rebuild moved
  // it 8→7), and a hardcoded delta over-clicks into the bound.
  const stepper = host.page.locator('.opt-row', { hasText: 'Rounds to win' }).locator('.stepper')
  const valEl = stepper.locator('.stepper-val')
  for (let guard = 0; guard < 25; guard++) {
    const cur = parseInt((await valEl.textContent())?.trim() ?? '', 10)
    if (cur === roundsToWin) break
    const btn =
      cur > roundsToWin
        ? stepper.locator('.stepper-btn').first()
        : stepper.locator('.stepper-btn').last()
    await btn.click()
    await humanPause(host.page, 50, 150)
  }

  // "Create lobby" is gated by `canStart` (handle ≥ 2 chars AND ≥ 1 pack).
  // The Core pack auto-selects from a useEffect after /api/packs resolves,
  // so the button can briefly be disabled at first paint.
  const createBtn = host.page.locator('button:has-text("Create lobby")')
  await expect(createBtn).toBeEnabled({ timeout: 15_000 })
  await humanPause(host.page)
  await createBtn.click()

  await host.page.waitForURL('**/lobby', { timeout: 15_000 })
  const code = /\/games\/([A-Z0-9]{6})\/lobby/.exec(host.page.url())?.[1] ?? ''
  expect(code, 'lobby URL carries a 6-char room code').toMatch(/^[A-Z0-9]{6}$/)
  return code
}

async function playerJoins(handle: Handle, roomCode: string): Promise<void> {
  await handle.page.goto('/games/join')
  await humanPause(handle.page)

  await handle.page.getByLabel('Room code').fill(roomCode)
  await humanPause(handle.page)
  await handle.page.getByLabel('Your handle').fill(handle.name)
  await humanPause(handle.page)

  await handle.page.click('button:has-text("Join game")')
  await handle.page.waitForURL('**/lobby', { timeout: 15_000 })
}

// The Czar has no hand dock (and renders a `.judge-bar` instead). We poll
// because a mid-transition snapshot can briefly show every player without
// a dock; require a stable n-1 docks visible before declaring a winner.
async function findCzar(players: Handle[]): Promise<Handle> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const docks = await Promise.all(
      players.map((h) =>
        h.page
          .locator('.hand-dock')
          .isVisible()
          .catch(() => false),
      ),
    )
    const docksOn = docks.filter(Boolean).length
    const without = players.filter((_, i) => !docks[i])
    if (docksOn === players.length - 1 && without.length === 1) return without[0]!
    await players[0]!.page.waitForTimeout(300)
  }
  throw new Error('could not identify czar after 12s of polling')
}

async function readPickCount(handle: Handle): Promise<number> {
  const eyebrow = handle.page.locator('.hand-dock .eyebrow')
  await eyebrow.waitFor({ state: 'visible', timeout: 15_000 })
  const txt = (await eyebrow.textContent()) ?? ''
  const m = /pick\s+(\d+|one|two|three)/i.exec(txt)
  if (!m) return 1
  const word = m[1]!.toLowerCase()
  if (word === 'one') return 1
  if (word === 'two') return 2
  if (word === 'three') return 3
  return Number(word)
}

// Real-click submission. The hand was reworked from a fanned arc to a
// flat flex strip with `gap: 10px` — adjacent cards no longer overlap,
// so .click() routes to the right target without dispatchEvent gymnastics.
async function submitNCardsViaClick(handle: Handle, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const card = handle.page.locator('.hand-card-wrap').nth(i).locator('.card-response')
    await card.waitFor({ state: 'visible', timeout: 10_000 })
    await humanPause(handle.page)
    await card.click()
  }
  const submit = handle.page.locator('.hand-dock-hd button:has-text("Submit")').first()
  await submit.waitFor({ state: 'visible', timeout: 10_000 })
  await expect(submit).toBeEnabled({ timeout: 5_000 })
  await humanPause(handle.page)
  await submit.click()
}

async function czarPicksFirstSubmission(czar: Handle): Promise<void> {
  // Reveal is server-staggered; wait for the last card to flip face-up.
  // `.flip-reveal` mounts per revealed card, so its presence on every
  // submission slot signals the canPick gate is open.
  await czar.page.locator('.flip-reveal').first().waitFor({ state: 'visible', timeout: 20_000 })
  // Small additional settle so the last stagger lands before the click.
  await humanPause(czar.page, 200, 500)
  await czar.page.locator('.flip-reveal').first().locator('.card-response').click()
}

// Reads the current round number from the topbar pill (`Round N`).
// Returns 0 if the pill isn't rendered yet (pre-game).
async function currentRound(handle: Handle): Promise<number> {
  const txt =
    (await handle.page
      .locator('.pill', { hasText: /Round/i })
      .first()
      .textContent()
      .catch(() => null)) ?? ''
  const m = /\d+/.exec(txt)
  return m ? Number(m[0]) : 0
}

// Drives a single round to resolution via the UI. Returns once either
// the topbar round counter increments (next round started) or the page
// has navigated to /end (game over). Polling the round number is more
// robust than racing on hand-dock visibility — during the post-resolve
// pause + first beat of round N+1 picking, the new czar's page shows
// neither hand-dock nor judge-bar.
async function playOneRound(players: Handle[]): Promise<{ ended: boolean }> {
  const czar = await findCzar(players)
  const nonCzars = players.filter((p) => p !== czar)
  const pick = await readPickCount(nonCzars[0]!)
  const startRound = await currentRound(czar)

  // Each non-czar selects + submits independently. Parallel to mirror real
  // user behavior — three people don't politely take turns.
  await Promise.all(nonCzars.map((p) => submitNCardsViaClick(p, pick)))

  // Wait for the reveal grid to render on the czar's page.
  await czar.page.locator('.subs-grid').waitFor({ state: 'visible', timeout: 20_000 })
  await czarPicksFirstSubmission(czar)

  // Resolve: either /end, or the round counter ticks past `startRound`.
  await czar.page.waitForFunction(
    (prev) => {
      if (location.pathname.endsWith('/end')) return true
      const pill = Array.from(document.querySelectorAll('.pill')).find((el) =>
        /Round/i.test(el.textContent ?? ''),
      )
      if (!pill) return false
      const m = /\d+/.exec(pill.textContent ?? '')
      return !!m && Number(m[0]) > prev
    },
    startRound,
    { timeout: 25_000 },
  )
  const ended = czar.page.url().endsWith('/end')
  if (ended) {
    await Promise.all(players.map((p) => p.page.waitForURL('**/end', { timeout: 15_000 })))
  } else {
    // Make sure every non-czar's round-N+1 dock has rendered before the
    // next iteration's findCzar polls. The new czar just stays in the
    // "waiting for submissions" state, which findCzar handles correctly.
    await Promise.all(
      nonCzars.map((p) =>
        p.page.waitForFunction(
          (prev) => {
            const pill = Array.from(document.querySelectorAll('.pill')).find((el) =>
              /Round/i.test(el.textContent ?? ''),
            )
            const m = pill ? /\d+/.exec(pill.textContent ?? '') : null
            return !!m && Number(m[0]) > prev
          },
          startRound,
          { timeout: 15_000 },
        ),
      ),
    )
  }
  await humanPause(players[0]!.page, 150, 400)
  return { ended }
}

test('UI golden path: 3 browsers create → play → win → rematch', async ({ browser }) => {
  // 3 rounds × ~7s = ~21s minimum; budget for stragglers + setup + rematch.
  test.setTimeout(240_000)

  const host = await newHandle(browser, 'Hostie')
  const alice = await newHandle(browser, 'Alice')
  const bob = await newHandle(browser, 'Bob')
  const players = [host, alice, bob]

  // Wrap teardown so a mid-test failure still closes contexts.
  try {
    const roomCode = await hostCreatesGame(host, 3)

    // Joiners enter in parallel — the lobby roster has to absorb both.
    await Promise.all([playerJoins(alice, roomCode), playerJoins(bob, roomCode)])

    // Host sees the full roster before starting. The lobby renders one
    // `.player-row` per handle inside `.player-list`.
    for (const name of ['Hostie', 'Alice', 'Bob']) {
      await expect(host.page.locator('.player-list')).toContainText(name, { timeout: 10_000 })
    }

    const startBtn = host.page.locator('button:has-text("Start game")')
    await expect(startBtn).toBeEnabled({ timeout: 15_000 })
    await humanPause(host.page)
    await startBtn.click()

    // All three reach /session — the lobby snapshot's status flip drives
    // the redirect on each page.
    await Promise.all(players.map((p) => p.page.waitForURL('**/session', { timeout: 20_000 })))

    // Play rounds until the game ends. Bound the loop generously (game
    // can outlast roundsToWin if score spreads; with 3 players + first-to-3
    // a worst-case run-up is ~9 rounds).
    let rounds = 0
    let ended = false
    for (rounds = 0; rounds < 20 && !ended; rounds++) {
      const r = await playOneRound(players)
      ended = r.ended
    }
    expect(ended, 'game reaches /end within the round budget').toBe(true)

    // End screen: every player sees the winner + scoreboard. The winner
    // banner element has class `.winner-name` per end.tsx. (Fallback to
    // text-level assertion if the class isn't present in this build.)
    for (const p of players) {
      await p.page.waitForURL('**/end', { timeout: 10_000 })
      // Scoreboard chips render one per player.
      await expect(p.page.locator('.score-chip')).toHaveCount(3, { timeout: 10_000 })
    }

    // Host clicks Rematch — every player navigates back into a fresh
    // /session with round 1 visible.
    const rematch = host.page.locator('button:has-text("Rematch")')
    await expect(rematch).toBeEnabled({ timeout: 10_000 })
    await humanPause(host.page)
    await rematch.click()

    await Promise.all(players.map((p) => p.page.waitForURL('**/session', { timeout: 20_000 })))
    // Round counter in the topbar reads "Round 1" on the fresh game.
    // (Concatenates with "Leave" in the rendered text — no word boundary.)
    for (const p of players) {
      await expect(p.page.locator('.pill', { hasText: /Round/i })).toContainText('Round 1', {
        timeout: 10_000,
      })
    }
  } finally {
    await Promise.all(players.map((p) => p.context.close().catch(() => undefined)))
  }
})
