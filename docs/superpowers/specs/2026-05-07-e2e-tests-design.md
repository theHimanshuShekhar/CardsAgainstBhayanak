# E2E Test Suite Design — Cards Against Bhayanak

**Date:** 2026-05-07  
**Status:** Approved

---

## Overview

End-to-end tests covering the full multiplayer game session flow using Playwright. Each test uses multiple browser contexts (one per player) within a single Playwright process, exercising WebSocket real-time state, UI rendering, and API routes together.

Minimum 3 players per test. Guest display names (no registration required) — the join/create endpoints accept `displayName` without an auth token.

---

## Architecture

### Test Runner

Playwright with `webServer` config — automatically starts `pnpm dev` before the suite and tears it down after. `reuseExistingServer: true` prevents killing an already-running local dev server.

```
baseURL: http://localhost:3000
webServer:
  command: pnpm dev
  url: http://localhost:3000
  reuseExistingServer: true
  env:
    ROUND_DELAY_MS: 1000
```

### Multi-Player Isolation

Each player gets a dedicated `browserContext` (isolated localStorage, cookies, WebSocket connection). Tests create 3+ contexts, each with its own `page`.

```ts
const [ctx1, ctx2, ctx3] = await Promise.all([
  browser.newContext(),
  browser.newContext(),
  browser.newContext(),
]);
```

All contexts are closed in `afterEach` regardless of test outcome.

### Guest Display Names

Format: `guest_${role}_${Date.now()}` — unique per test run, no DB cleanup required.

---

## File Structure

```
e2e/
  playwright.config.ts
  fixtures/
    game.ts                      — createGame(), joinGame() helpers
  tests/
    01-lobby.spec.ts
    02-single-round.spec.ts
    03-multi-round-scoring.spec.ts
    04-end-game.spec.ts
    05-rando-cardrissian.spec.ts
    06-happy-ending.spec.ts
    07-packing-heat.spec.ts
    08-spectator.spec.ts
    09-mid-game-join.spec.ts
    10-simultaneous-submit.spec.ts
```

---

## Fixtures (`e2e/fixtures/game.ts`)

### `createGame(page, options?)`

Navigates to `/games/create`, fills in host display name, selects pack 1, sets `totalRounds` (default 2 for speed), toggles any house rules, submits. Returns `{ roomCode, playerId }` parsed from the lobby URL query params.

### `joinGame(page, roomCode, displayName, options?)`

Navigates to `/games/join`, fills display name and room code, optionally sets spectator toggle, submits. Returns `{ playerId }` parsed from the redirect URL.

### `startGame(hostPage)`

Clicks the Start Game button on the lobby page. Waits for the page to navigate to the session route.

### `playCard(page)`

Selects the first available white card in the player's hand and clicks Play. Waits for the card to be marked as played.

### `pickWinner(czarPage)`

Clicks the Pick button on the first anonymous submission. Waits for the score update.

---

## Test Scenarios

### 01 — Lobby Flow

**Players:** 3  
**Config:** default (no house rules)

1. Host creates game → lands on lobby
2. Player 2 and Player 3 join → all 3 names appear in player list for all contexts
3. Non-host contexts do not show the Start button
4. Host clicks Start → all 3 contexts navigate to `/games/$code/session`

### 02 — Single Round

**Players:** 3  
**Config:** 2 rounds, no house rules

1. Game starts, all players see the black card
2. Player 1 is czar — no hand shown, no play button
3. Players 2 and 3 play a card each
4. After both play, czar sees 2 anonymous submissions
5. Czar picks one — winner's score increments by 1; others remain 0
6. Scoreboard reflects correct scores for all 3 contexts

### 03 — Multi-Round Scoring

**Players:** 3  
**Config:** 3 rounds, no house rules

1. Play through 3 full rounds using `playCard` + `pickWinner` helpers
2. After each round, verify czar role rotated to the next player (index-based)
3. After 3 rounds, verify each czar awarded exactly 1 win to someone
4. Verify round counter increments correctly on all contexts

### 04 — End Game

**Players:** 3  
**Config:** 2 rounds (minimum to reach end)

1. Play through all rounds
2. After final round's winner is picked, all 3 contexts navigate to `/games/$code/end`
3. End screen shows final scores for all players
4. Player with highest score is highlighted as winner

### 05 — Rando Cardrissian

**Players:** 3 humans  
**Config:** 2 rounds, `randoCardrissian: true`

1. Game starts — Rando Cardrissian appears in player list
2. In each round, czar sees 3 submissions (2 human + 1 Rando)
3. Czar can pick Rando's submission (game does not stall or error)
4. If Rando wins, no DB foreign key error occurs (guarded in `pickWinner`)

### 06 — Happy Ending

**Players:** 3  
**Config:** 2 rounds, `happyEnding: true`

1. Play through round 1 normally
2. In round 2 (final), the black card displayed is the haiku card (pick=3)
3. All 3 non-czar players each submit 3 white cards
4. Czar sees all submissions and picks a winner
5. Game ends normally after the haiku round

### 07 — Packing Heat

**Players:** 3  
**Config:** 5 rounds, `packingHeat: true`

1. Game starts and deck loads
2. After each `round:started` event, check the hand size via `/api/games/$code/hand` for each non-czar player
3. When a round's black card has `pick >= 2`, assert each non-czar player's hand size equals `7 + (pick - 1)` (the extra cards dealt by packing heat)
4. Players submit the required number of cards for that round; round completes normally
5. Test passes once at least one packing-heat round is verified across the 5 rounds

> Note: 5 rounds gives high probability of drawing at least one multi-pick black card from pack 1. Hand size is the observable signal — no need to inspect Redis directly.

### 08 — Spectator

**Players:** 3 players + 1 spectator  
**Config:** 2 rounds, no house rules

1. 3 players join normally; 1 joins as spectator
2. Spectator appears in player list (not counted in active players)
3. Spectator sees the black card in real-time
4. Spectator has no hand rendered and no play button
5. Spectator sees submissions appear as players play
6. Game's "all submitted" check does not wait on spectator — round proceeds normally

### 09 — Mid-Game Join

**Players:** 3 (start) + 1 (joins after start)  
**Config:** 3 rounds, no house rules

1. 3 players join and host starts game — round 1 begins
2. A 4th player joins mid-game (hits `/games/$code/join` while status=active)
3. 4th player sees `isPending` state — no hand until next round
4. Round 1 plays out with 3 players (czar + 2 submitters)
5. At round 2 start, pending player is dealt 7 cards and can play normally
6. 4th player participates fully from round 2 onward

### 10 — Simultaneous Submission

**Players:** 3  
**Config:** 2 rounds, no house rules

1. Game starts, czar is identified
2. Attach a WebSocket message listener on the czar's page via Playwright's `page.on('websocket', ...)` before cards are played, counting `all:played` frames
3. Both non-czar players fire `playCard()` simultaneously via `Promise.all`
4. Verify the `all:played` counter on the czar's page equals exactly 1 (no duplicate publishes)
5. Czar sees exactly 2 anonymous submissions (no duplicates or missing entries)
6. Round proceeds normally to czar pick

---

## Round Delay Fix

`pickWinner()` in `game-engine.ts` uses a 10-second delay before starting the next round. Without a fix, multi-round tests take 20+ seconds of idle waiting.

**Change:** Read delay from `ROUND_DELAY_MS` environment variable, defaulting to `10000`.

```ts
// game-engine.ts — inside pickWinner()
const delay = Number(process.env.ROUND_DELAY_MS ?? 10_000);
setTimeout(() => startRound(roomCode), delay);
```

Playwright config sets `ROUND_DELAY_MS=1000` in the `webServer.env` block. Production default is unchanged.

---

## What Is Not Covered

- Auth flows (login, register) — covered by existing Vitest route tests
- Game engine unit logic (deal, submit validation) — covered by existing Vitest tests
- Load / performance testing — out of scope
- Mobile viewport testing — out of scope

---

## Dependencies

- `@playwright/test` (new devDependency)
- Docker services running (Postgres + Redis) — same requirement as existing Vitest tests
- Card data seeded (`pnpm seed`) — required for deck loading
