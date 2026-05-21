import { test, expect } from '@playwright/test'
import {
  createGame,
  joinGame,
  getCzar,
  submitCards,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// Three UI wirings that aren't covered by the rule slices:
//   D — Leave: clicking Leave on /lobby clears `cab_session` from
//       localStorage and routes the player back to "/".
//   E — Reconnect: reloading the page mid-round re-uses the persisted
//       session, the client sends auth+rejoin, and state_snapshot
//       restores the same prompt/round on the rejoined page.
//   F — Stage timer: with a non-Off round timer (the default 60s) the
//       .stage-timer node mounts on every player's page during the
//       picking phase and counts down off the wall clock.

test('Leave (D): clicking Leave on /lobby clears the session and navigates home', async ({
  browser,
}) => {
  test.setTimeout(60_000)
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 3 })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  // Alice clicks the lobby's Leave button.
  await alice.page.click('button:has-text("Leave")')

  // She lands on the home route ("/") — not /lobby, not /session.
  await alice.page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 })

  // Her cab_session is cleared so a refresh won't re-join automatically.
  const cleared = await alice.page.evaluate(() => localStorage.getItem('cab_session'))
  expect(cleared).toBeNull()

  await Promise.all([host, alice, bob].map((h) => h.context.close()))
})

test('Reconnect (E): reloading mid-round restores the same round + prompt via rejoin', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 5 })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Wait for the prompt to render on Alice's page so the round is live.
  await alice.page.locator('.card-prompt, .stage-prompt').first().waitFor({ timeout: 15_000 })

  // Snapshot Alice's round + prompt text before the reload.
  const roundBefore = (await alice.page.locator('.pill').first().textContent()) ?? ''
  const promptBefore = (await alice.page.locator('.card-prompt').first().textContent()) ?? ''
  expect(promptBefore.length).toBeGreaterThan(0)

  // Hard-reload her tab. The same context keeps localStorage; the page
  // mounts, reads cab_session, sends auth+rejoin → state_snapshot.
  await alice.page.reload()

  // She lands back on /session (lobby route inspects SessionStatus and
  // forwards 'active' → /session).
  await alice.page.waitForURL('**/session', { timeout: 20_000 })

  // Same round + same prompt. The prompt is the per-round black card;
  // identical text means rejoin restored the exact round state.
  await expect
    .poll(async () => (await alice.page.locator('.pill').first().textContent()) ?? '', {
      timeout: 15_000,
    })
    .toBe(roundBefore)
  await expect
    .poll(async () => (await alice.page.locator('.card-prompt').first().textContent()) ?? '', {
      timeout: 15_000,
    })
    .toBe(promptBefore)

  await Promise.all(players.map((h) => h.context.close()))
})

test('Stage timer (F): .stage-timer mounts on every page during picking and counts down', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  // Default config carries timer:'60s' — no need to drive the editor.
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 5 })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Find the czar — the timer mounts inside PromptStage for picking/waiting,
  // so every page (czar included) renders it.
  const czar = await getCzar(players)

  // Stage timer is visible on every page. The text is m:ss; with timer:60s
  // it starts at "1:00" and ticks down. Use a regex tolerant of either
  // 0:59 (already ticked) or 1:00 (fresh).
  for (const p of players) {
    const timer = p.page.locator('.stage-timer').first()
    await expect(timer).toBeVisible({ timeout: 15_000 })
    await expect(timer).toHaveText(/^[0-1]:[0-5]\d$/)
  }

  // The countdown decreases. Read on Alice (a non-czar), wait 2s, read
  // again — the second read should be strictly smaller in total seconds.
  function readSecs(handle: PlayerHandle): Promise<number> {
    return handle.page
      .locator('.stage-timer')
      .first()
      .textContent()
      .then((t) => {
        const m = /^(\d+):(\d\d)$/.exec((t ?? '').trim())
        return m ? parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10) : -1
      })
  }
  const t1 = await readSecs(alice)
  await alice.page.waitForTimeout(2200)
  const t2 = await readSecs(alice)
  expect(t1).toBeGreaterThan(0)
  expect(t2).toBeLessThan(t1)

  // Submitting a card should not remove the timer (it stays during the
  // 'waiting' phase until the round resolves). Submit a non-czar's pick
  // and re-assert the timer is still mounted.
  const submitter = players.find((p) => p !== czar)!
  const pick = await handPickCount(submitter)
  await submitCards(submitter, pick)
  await expect(submitter.page.locator('.stage-timer').first()).toBeVisible()

  await Promise.all(players.map((h) => h.context.close()))
})
