import { test, expect } from '@playwright/test'
import {
  createGame,
  joinGame,
  playRound,
  getCzar,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// End-screen host actions — Rematch and Back-to-lobby. The reset
// flow itself is protocol-tested in full-game.spec.ts via REST; this
// spec asserts the *UI wiring*: the host's two end-screen buttons
// drive the game_reset event that navigates every player to /session
// (rematch) or /lobby (back-to-lobby).

// The GameConfigEditor enforces roundsToWin ≥ 3 — we can't end after a
// single round. Loop playing rounds until the host's page hits /end
// (game_over for everyone broadcasts together). Capped to keep the
// test from running forever if the seed produces no decisive wins.
async function driveTo3GameOver(players: PlayerHandle[]): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (players[0]!.page.url().includes('/end')) return
    // Pick count must come from a non-czar (czar has no hand dock to read
    // the eyebrow label from). playRound itself finds the czar again, so
    // there's no race between this read and the submissions it drives.
    const czar = await getCzar(players)
    const submitter = players.find((p) => p !== czar) ?? players[0]!
    const pick = await handPickCount(submitter).catch(() => 1)
    const host = players[0]!
    const label = (await host.page.locator('.pill').first().textContent()) ?? ''
    const roundBefore = Number(/Round (\d+)/.exec(label)?.[1] ?? 0)
    await playRound(players, pick)
    // The result hold can finish with either round_started or game_over.
    // Do not begin another hand submission before that public transition.
    await expect
      .poll(
        async () => {
          if (host.page.url().includes('/end')) return true
          const nextLabel = await host.page
            .locator('.pill')
            .first()
            .textContent({ timeout: 1_000 })
            .catch(() => '')
          return Number(/Round (\d+)/.exec(nextLabel ?? '')?.[1] ?? 0) > roundBefore
        },
        { timeout: 30_000 },
      )
      .toBe(true)
  }
  await Promise.all(players.map((h) => h.page.waitForURL('**/end', { timeout: 30_000 })))
}

test('end screen: host Rematch button navigates all players into a fresh /session', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 3 })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')
  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  await driveTo3GameOver(players)

  // Only the host sees the Rematch/Back-to-lobby buttons; everyone else
  // sees a disabled "Waiting for the host…" placeholder.
  await expect(host.page.locator('button:has-text("Rematch")')).toBeVisible({ timeout: 10_000 })
  await expect(host.page.locator('button:has-text("Back to lobby")')).toBeVisible()
  for (const p of [alice, bob]) {
    await expect(p.page.locator('button:has-text("Waiting for the host")')).toBeVisible({
      timeout: 10_000,
    })
    await expect(p.page.locator('button:has-text("Rematch")')).toBeHidden()
  }

  await host.page.click('button:has-text("Rematch")')

  // Every player lands back on /session for the fresh game.
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // Round counter resets to 1 (the rematch is round 1 of a new game).
  for (const p of players) {
    await expect
      .poll(
        async () => {
          const t = (await p.page.locator('.pill').first().textContent()) ?? ''
          const m = /Round (\d+)/.exec(t)
          return m ? parseInt(m[1]!, 10) : 0
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1)
  }

  await Promise.all(players.map((h) => h.context.close()))
})

test('end screen: host Back-to-lobby button returns all players to /lobby', async ({ browser }) => {
  test.setTimeout(180_000)
  const { handle: host, roomCode } = await createGame(browser, 'Host', { roundsToWin: 3 })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')
  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  await driveTo3GameOver(players)

  await expect(host.page.locator('button:has-text("Back to lobby")')).toBeVisible({
    timeout: 10_000,
  })
  await host.page.click('button:has-text("Back to lobby")')

  // Every player lands back on /lobby. The lobby screen replaces
  // /session/end as the staging area for the next game's config.
  await Promise.all(players.map((h) => h.page.waitForURL('**/lobby', { timeout: 20_000 })))

  // Host sees the editor's "Start game" button (back to pre-game state).
  await expect(host.page.locator('button:has-text("Start game")')).toBeVisible({ timeout: 15_000 })

  await Promise.all(players.map((h) => h.context.close()))
})
