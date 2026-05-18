import { test, expect } from '@playwright/test'
import { HANDLES } from '../fixtures/handles'
import {
  createGame,
  joinGame,
  getCzar,
  handPickCount,
  submitCards,
  waitForPhase,
  pickWinner,
} from '../helpers'
import {
  playRound,
  playGodmode,
  playHappyEnding,
  playCzarDrop,
  playHostDrop,
  playAllDrop,
  playSpectatorReject,
  playDroppedAuth,
  playLobbySnapshot,
} from '../protocol'

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
  expect(r.round1StartedCount, 'N-1: round 1 round_started emitted exactly once').toBe(1)
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

test('Packing Heat: pick-2 prompt deals an 11th card (protocol)', async () => {
  test.setTimeout(60_000)
  const r = await playRound(BASE, { rules: ['packing_heat'], players: 3 })
  // Conditional but always meaningful: pick-2 ⇒ +1 card (11), else no-op.
  if (r.promptPick === 2) {
    expect(r.submitterHandLen, 'pick-2 ⇒ Packing Heat adds an 11th card').toBe(11)
  } else {
    expect(r.submitterHandLen, 'pick-1 ⇒ Packing Heat is a no-op').toBe(10)
  }
  expect(r.roundWon).toBe(true)
  expect(r.reachedRound2).toBe(true)
})

test('Happy Ending: host forces a Haiku final round (protocol)', async () => {
  test.setTimeout(90_000)
  const r = await playHappyEnding(BASE)
  expect(r.round2Prompt, 'round 2 is the synthetic Haiku prompt').toBe('Make a Haiku.')
  expect(r.round2Pick, 'Haiku prompt is pick-3').toBe(3)
  expect(r.gameOver, 'game ends after the Haiku round').toBe(true)
  expect(r.mode, 'game_over carries happy_ending mode').toBe('happy_ending')
})

test('S2-1: Czar drop mid-judging voids the round and rotates Czar (protocol)', async () => {
  test.setTimeout(70_000)
  const r = await playCzarDrop(BASE)
  expect(r.roundVoided, 'grace expiry voids the abandoned round').toBe(true)
  expect(r.voidedRound, 'round 1 is the one voided').toBe(1)
  expect(r.round2Started, 'a fresh round starts after the void').toBe(true)
  expect(r.czarRotated, 'the dropped Czar is not the new Czar').toBe(true)
})

test('S2-1: host drop migrates the host role (protocol)', async () => {
  test.setTimeout(70_000)
  const r = await playHostDrop(BASE)
  expect(r.hostChanged, 'grace expiry emits host_changed').toBe(true)
  expect(r.newHostId, 'host migrates to the longest-present active player (p2)').toBe(
    r.expectedHostId,
  )
  expect(r.newHostId, 'new host is not the dropped host').not.toBe(r.oldHostId)
})

test('S2-1: all players dropping pauses the game (protocol)', async () => {
  test.setTimeout(70_000)
  const r = await playAllDrop(BASE)
  expect(r.paused, `every player gone ⇒ session paused (was ${r.gameStatus})`).toBe(true)
})

test('S2-3: spectator game actions are rejected (protocol)', async () => {
  test.setTimeout(30_000)
  const r = await playSpectatorReject(BASE)
  expect(r.authedOk, 'spectator still authenticates').toBe(true)
  expect(r.errorCode, 'blocked action ⇒ spectator_action').toBe('spectator_action')
})

test('S2-4: re-auth as a dropped player yields player_dropped (protocol)', async () => {
  test.setTimeout(50_000)
  const r = await playDroppedAuth(BASE)
  expect(r.gotAuthOk, 'a dropped player must not re-authenticate').toBe(false)
  expect(r.authErrorCode, 'auth_error carries player_dropped').toBe('player_dropped')
})

test('S2-5: lobby gets roster + config, then state_snapshot post-start (protocol)', async () => {
  test.setTimeout(40_000)
  const r = await playLobbySnapshot(BASE)
  expect(r.gotLobbySnapshot, 'rejoin in lobby yields lobby_snapshot').toBe(true)
  expect(r.gameStatus, 'pre-game status is lobby').toBe('lobby')
  expect(r.rosterSize, 'snapshot carries the full roster (host + p2 + p3)').toBe(3)
  expect(r.configRoundsToWin, 'config.roundsToWin round-trips').toBe(5)
  expect(r.configMaxPlayers, 'config.maxPlayers round-trips').toBe(8)
  expect(r.configTimer, 'config.timer round-trips').toBe('90s')
  expect(
    r.postStartIsStateSnapshot,
    'after start, rejoin yields state_snapshot not lobby_snapshot',
  ).toBe(true)
})

// UI-driven golden path. The blockers in the old skip note (create
// packs/rules UI S2-6/S2-16, lobby start+snapshot S2-5, end screen S2-8)
// have all landed, so a 6-player game now plays end-to-end through the
// real UI. The Czar picks submission 0 each round; the server shuffles
// submission order, so the winner is effectively a random submitter and
// someone reaches 5 within the round cap.
test('6-player 5-win golden path', async ({ browser }) => {
  test.setTimeout(8 * 60_000)
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

  await waitForPhase(allHandles, 'picking')
  for (let round = 1; round <= 60; round++) {
    const czar = await getCzar(allHandles)
    const nonCzars = allHandles.filter((h) => h !== czar)
    const pick = await handPickCount(nonCzars[0]!)
    for (const np of nonCzars) await submitCards(np, pick)
    await waitForPhase(allHandles, 'judging')
    await pickWinner(czar, 0)
    // Deciding round ⇒ game_over ⇒ every player navigates to /end;
    // otherwise the next round's picking phase begins. Exactly one of
    // these resolves quickly, so the race is unambiguous.
    const outcome = await Promise.race([
      host.page
        .waitForURL('**/end', { timeout: 30_000 })
        .then(() => 'end' as const)
        .catch(() => 'timeout' as const),
      waitForPhase(allHandles, 'picking')
        .then(() => 'next' as const)
        .catch(() => 'timeout' as const),
    ])
    if (outcome === 'end') break
    expect(outcome, `round ${round} neither ended nor advanced`).toBe('next')
  }

  await Promise.all(allHandles.map((h) => h.page.waitForURL('**/end', { timeout: 30_000 })))
  for (const h of allHandles) await expect(h.page.locator('body')).toBeVisible()
  await Promise.all(allHandles.map((h) => h.context.close()))
})

test('join as spectator cannot submit cards', async ({ browser }) => {
  test.setTimeout(90_000)
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
