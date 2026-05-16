import { test, expect } from '@playwright/test'
import { HANDLES } from '../fixtures/handles'
import { createGame, joinGame } from '../helpers'
import { playRound, playGodmode } from '../protocol'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'

// Protocol-level backbone: drives the real HTTP + WebSocket stack with no
// browser, so it works regardless of UI completeness. This is the
// regression guard for engine/game-loop work.
test('normal mode: full round progresses (protocol)', async () => {
  test.setTimeout(60_000)
  const r = await playRound(BASE, { rules: [], players: 3 })
  expect(r.revealStart, 'server emits reveal_start').toBe(true)
  expect(r.cardRevealed, 'card_revealed per submission').toBeGreaterThanOrEqual(2)
  expect(r.roundWon, 'czar pick resolves to round_won').toBe(true)
  expect(r.roundEnd, 'round_end fires').toBe(true)
  expect(r.reachedRound2, 'loop advances to round 2').toBe(true)
})

test('God Is Dead: no self/double vote, round resolves (protocol)', async () => {
  test.setTimeout(60_000)
  const r = await playGodmode(BASE, { players: 3 })
  expect(r.selfVoteIgnored, 'self-vote + dupes must not resolve the round').toBe(true)
  expect(r.doubleVoteIgnored).toBe(true)
  expect(r.roundWon, 'resolves once all unique voters vote').toBe(true)
  expect(r.reachedRound2, 'loop advances after vote resolution').toBe(true)
})

test('Rando Cardrissian auto-submits each round (protocol)', async () => {
  test.setTimeout(60_000)
  // 3 humans (1 czar, 2 submitters) + Rando ⇒ 3 revealed submissions.
  const r = await playRound(BASE, { rules: ['rando'], players: 3 })
  expect(r.cardRevealed, 'two human submissions + Rando').toBe(3)
  expect(r.roundWon).toBe(true)
  expect(r.reachedRound2).toBe(true)
})

// UI-driven coverage. Blocked until the create-screen packs/rules UI
// (S2-6/S2-16), lobby start + snapshot (S2-5), and end screen (S2-8)
// land — without them the create flow submits empty packs and the game
// cannot start. Re-enable as those ship.
test.skip('6-player 5-win golden path', async ({ browser }) => {
  const { handle: host, roomCode } = await createGame(browser, HANDLES[0], {
    roundsToWin: 5,
    maxPlayers: 6,
  })
  const players = await Promise.all(
    HANDLES.slice(1).map((name) => joinGame(browser, name, roomCode)),
  )
  const allHandles = [host, ...players]
  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')
  await Promise.all(allHandles.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))
  await Promise.all(allHandles.map((h) => h.page.waitForURL('**/end', { timeout: 5 * 60 * 1_000 })))
  for (const h of allHandles) await expect(h.page.locator('body')).toBeVisible()
  await Promise.all(allHandles.map((h) => h.context.close()))
})

test.skip('join as spectator cannot submit cards', async ({ browser }) => {
  const { handle: host, roomCode } = await createGame(browser, 'HostUser', { roundsToWin: 3 })
  const player1 = await joinGame(browser, 'PlayerOne', roomCode)
  const player2 = await joinGame(browser, 'PlayerTwo', roomCode)
  const spectator = await joinGame(browser, 'Watcher', roomCode, 'spectator')
  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')
  await Promise.all(
    [host, player1, player2, spectator].map((h) =>
      h.page.waitForURL('**/session', { timeout: 20_000 }),
    ),
  )
  const submitBtn = spectator.page.locator('button:has-text("Submit")')
  await expect(submitBtn).not.toBeVisible()
  await Promise.all([host, player1, player2, spectator].map((h) => h.context.close()))
})
