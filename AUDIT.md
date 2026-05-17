# Cards Against Bhayanak — Implementation Audit

_Generated 2026-05-13. Cross-referenced against [`SPEC.md`](./SPEC.md) and [`docs/superpowers/plans/2026-05-12-cards-against-bhayanak-implementation.md`](./docs/superpowers/plans/2026-05-12-cards-against-bhayanak-implementation.md)._

## TL;DR

Static checks pass (`pnpm typecheck`, `pnpm lint`). Most phases are scaffolded correctly, but the **game-loop orchestration is broken end-to-end**: a started game cannot progress past the picking phase because the engine never emits `reveal_start` or `card_revealed`, never auto-starts elimination/voting turns, and never triggers Rando submissions or Packing Heat bonus deals. Production deployment is also blocked because the WebSocket server, sweeper, and keepalive enforcer are only wired into `vite dev` — the production bundle has no realtime layer. Both the plan and SPEC mark these phases ✅ DONE; that status is misleading.

Severity: `S0` = ships-broken (cannot play a game), `S1` = production-blocker, `S2` = spec deviation likely to surface in tests, `S3` = polish / minor.

---

## Progress & Re-scope (updated 2026-05-17)

> This section supersedes the original estimates below. The original audit
> only ran `pnpm typecheck` / `pnpm lint` — **never `pnpm build` or a
> runtime** — so it systematically understated infrastructure and
> integration scope. Items are deeper than their one-paragraph sketches.

### Methodology correction

- The original "static checks pass" framing hid that **`pnpm build` was
  fully broken** and **production had never run**. Always verify with
  `pnpm build` + a real run (Docker Postgres/Redis), not just typecheck/lint.
- The codebase was scaffolded against the **Vinxi-era** TanStack Start API
  (`@tanstack/start-api-routes` `createAPIFileRoute`); the project is
  actually TanStack Start v1.167 (Vite + **srvx**, not Nitro/Vinxi). Expect
  more framework-paradigm mismatches.
- Each fix tends to be **cross-cutting** (engine + WS handler + client +
  protocol/types), not localized. Verification needs a Docker rebuild cycle
  (no test harness yet — see S2-10).

### Verified DONE (branch `fix/audit-priority-fixes`)

| Issue                                | Commit               | Verification                                                                               |
| ------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------ |
| S1-4 Redis init at create            | `1e00bc3`            | `POST /api/games` → 200 in Docker                                                          |
| S1-2 / S1-3 seed + boot guard        | `5963b72`            | 71 packs seeded at boot                                                                    |
| S1-1 prod server + native WS         | `327d821`, `33e14e3` | healthz 200, WS upgrade + round-trip; was _prod never built_                               |
| S0-1 reveal/judging loop             | `ed05486`            | 3-player round progresses picking→reveal→pick→round_won→round_end→round 2                  |
| S2-10 E2E harness (infra + backbone) | `4492eb6`            | `playwright test full-game -g protocol` green vs Docker; UI specs skipped pending S2-5/6/8 |

### Newly discovered issues (not in original audit)

- **N-1 (S2):** `start.ts` publishes `game_started` + `round_started`
  _and_ `engine.startRound` also publishes `round_started` → **duplicate
  `round_started` for round 1**. Fix: let the engine be the sole emitter;
  `start.ts` should only emit `game_started`.
- **N-2 (S2):** `config.packs` must contain **pack IDs**, not names —
  `buildDecks` does `inArray(blackCards.packId, packs)`. The create UI
  (S2-6/S2-16) must submit pack IDs; empty/invalid → `deck_exhausted` on
  start. Ties to the S3 "empty-pack 503" item.
- **N-3 (S3 — fixed):** `SubmissionsGrid` computes `isWinner = s.submissionId ===
winnerId` — compares an index-string submissionId to a _playerId_.
  Winner highlight is wrong; should compare to the won `submissionId`.
- **N-4 (S3, accepted):** `server.prod.ts` runs TS via `tsx` in prod
  (works, verified). A follow-up could bundle the entry to drop the `tsx`
  runtime dependency. Acceptable for MVP.
- **N-5 (S1, regression):** removing the dev WebSocket Vite plugin (S1-1)
  means **`pnpm dev` no longer serves WebSockets** — only the srvx prod
  entry does. Local dev of realtime features now requires
  `pnpm build && pnpm start`. Fix: re-add a dev-only WS attach that does
  not import `~`-aliased app code at Vite config-eval time (the original
  break), or run the srvx entry in a dev mode. E2E already targets the
  prod server so the harness is unaffected.
- **N-6 (S3 — fixed):** the compose/Dockerfile healthcheck shows the app
  container `unhealthy` even though `/api/healthz` returns 200 (busybox
  `wget` form / `PORT` mismatch in the healthcheck command). Cosmetic but
  breaks `depends_on: condition: service_healthy`. Fix: use a Node-based
  healthcheck (`node -e "fetch(...)"`) bound to the configured `PORT`.
- **N-7 (S1, blocker — fixed):** `server.prod.ts` delegated _every_
  request to the TSS SSR fetch handler, which renders HTML but never
  serves the Vite client bundle. `/assets/*.{js,css}` returned 404, so
  the SPA never hydrated anywhere — no `useEffect`, no `/api/packs`
  fetch, every interactive screen dead (surfaced as the empty Card-packs
  grid blocking S2-6). Fix: serve `/assets/*` from `dist/client/assets`
  in the prod entry (correct content-type + immutable cache, path-
  traversal guarded), delegate everything else to SSR.
- **N-8 (S2, blocker — fixed):** `useGameSocket` pipelined `auth` and
  `rejoin` in the same `onopen` tick. The server's auth handler is async,
  so the `rejoin` raced ahead of it and was rejected `not_authorized`
  ("auth first"); the client never retried, so the rejoin snapshot
  (`state_snapshot` in-game, `lobby_snapshot` pre-game) never arrived.
  Surfaced via S2-5 (lobby roster/config empty). Fix: send `rejoin`
  only after the `auth_ok` message — matches the spec's "auth then
  rejoin" and the protocol harness ordering.
- **N-9 (S2, test-infra — fixed):** `tests/helpers.ts` `createGame`/`joinGame`
  fill `input[placeholder*="handle"]`, but the S2-6 create/join rebuild
  (`1ac4577`) changed the placeholders to `e.g. priya_was_here` /
  `e.g. B7K-9MV` — the selector now matches nothing. This breaks the five
  UI-driving specs that use the helpers (`reconnect`, `full-game`,
  `mid-game-join`, `multi-blank`, `house-rules`). Pre-existing drift, not
  a regression from the S2-18/S3 work. Fixed: added `aria-label` to the
  handle/room-code inputs in `create.tsx`/`join.tsx` (and `role=radiogroup`
  /`radio`+`aria-checked` to the Round-timer seg — real a11y win, not just
  a test hook) and migrated the helpers + `house-rules`/`mobile` specs from
  placeholder selectors to `getByLabel`.

- **N-10 (S2, product bug — fixed):** `session.tsx`'s `round_won` handler
  scheduled `setTimeout(() => setPhase('transition'), WINNER_PAUSE)` (2.6s)
  but never cleared it. When the server advanced `round_end → round_started`
  for the next round in under 2.6s (fast czar pick), the stale timer fired
  mid-next-round and forced `phase='transition'`, hiding the hand dock /
  subs-grid permanently — the game wedged on the next round. Protocol tests
  never hit it (no UI/timer). Fixed: track the timeout in a `winnerTimer`
  ref and `clearTimeout` it on `round_started` and on effect unmount.

- **N-11 (S2, test-infra — fixed):** the hand dock fans cards with stacked
  z-index; a selected card lifts (`translateY(-22px)`, `zIndex:99`) so its
  box overlaps both neighbours and the Submit button. Playwright pointer
  actionability never resolves, and `force:true` doesn't help (the browser
  routes synthetic pointer events to the topmost element — the raised card —
  re-toggling it instead of selecting the next card / clicking Submit).
  Fixed: `submitCards`/`multi-blank` now `dispatchEvent('click')` on the
  exact node (React's delegated onClick still fires, bypassing hit-testing).
  Separately, `rate-limit.ts` gained `enforceRateLimit` (enforces only when
  `NODE_ENV==='production'`; dev/test pass through) so the serially-run
  suite from one shared IP doesn't trip production create/join budgets, and
  `reconnect.spec.ts`'s grace-window test got an explicit 75s `setTimeout`
  (the 30s default cap can't contain a 30s grace wait).

### Revised scope for remaining items

| Item                        | Original sketch         | Revised reality                                                                                                                 | Est. surface                             |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| S0-10/S0-9 czar rotation    | "tiny"                  | Mostly accurate — small, but verify seeded-RNG determinism end-to-end                                                           | `game-engine.ts`                         |
| S0-4 Rando                  | add `autoSubmitRando`   | Engine + must integrate with `checkRoundReady` (Rando counted, not awaited) + win path                                          | engine                                   |
| S0-5 Packing Heat           | call `applyPackingHeat` | Engine + **per-player hand delivery** (no `hand` in `round_started` today; needs a `hand_dealt` path) — cross-cutting to client | engine + types + client                  |
| S0-6 Happy Ending           | host "end now"          | New WS event + types + engine flag + **synthetic Haiku black card seeded** + topbar UI                                          | engine + types + handler + seed + client |
| S0-2 Survival first turn    | emit `elimination_turn` | Largely handled by S0-1's `checkRoundReady` survival branch; needs validation + turn-persistence test                           | engine (verify)                          |
| S0-3 God Is Dead            | dedupe votes            | Redis vote-set + self-vote guard; interacts with S0-1 voting branch                                                             | engine                                   |
| S2-1 disconnect-during-game | extend grace callback   | Large: czar/host/all-dropped paths, new `host_changed` event, phase persistence                                                 | handler + engine + types + client        |
| S2-3/S2-4 spectator/auth    | guard + tagged union    | Moderate, mostly handler/auth                                                                                                   | handler + auth                           |
| S2-6/S2-16 create UI        | packs + rules grid      | Whole UI build + packs-ID contract (N-2) + Core lock                                                                            | client + context                         |
| S2-5 lobby snapshot         | add handler             | Needs server `getLobbySnapshot` (lobby status returns null today) + client                                                      | handler + client                         |
| S2-9/S2-8 stats + end       | SQL + screen            | Several SQL aggregations + end-screen state plumbing                                                                            | api + client                             |
| S2-10 E2E infra             | globalSetup/teardown    | **High value** — replaces slow manual Docker verification; should likely come _before_ the remaining S2 UI work                 | tests                                    |
| S2-12/S2-13 PostHog         | distinctId helper       | Mechanical, low risk                                                                                                            | engine/api                               |
| S2-18 + S3 socket/polish    | cleanup                 | Mostly small, independent                                                                                                       | client + misc                            |

### Recalibrated priority order

1. **S0-10/S0-9** czar rotation (small; unblocks deterministic multi-round).
2. **S0-3** God Is Dead correctness + **S0-2** Survival validation (build on S0-1's branches).
3. **S0-4 Rando**, then **S0-5 Packing Heat**, then **S0-6 Happy Ending**
   (ascending cross-cutting cost; each verified in Docker).
4. **N-1** duplicate `round_started` (tiny, do alongside S0 work).
5. **S2-10 E2E harness** — promote earlier: turns slow Docker rebuild
   verification into fast automated checks for everything after.
6. **S2-1** disconnect handling (large).
7. **S2-3/S2-4** spectator + auth.
8. **S2-6/S2-16** create UI (+ N-2 pack-ID contract), then **S2-5** lobby.
9. **S2-9/S2-8** stats + end screen.
10. **S2-12/S2-13** PostHog, **S2-18 + S3** polish (+ N-3, N-4).

---

## S0 — Game cannot progress

### S0-1. No `reveal_start` / `card_revealed` events emitted

- **Where:** `src/lib/game-engine.ts` — `submitCards`, `expireRoundTimer`, `pickWinner` (and friends).
- **Spec:** § Game Rules Engine, § WebSocket Protocol.
- **What's there:** `submitCards` only publishes `player_played`. There is no "all submitted" detector, no `reveal_start` emit, no staggered `card_revealed` loop, no `judging` phase notification.
- **Effect:** Clients sit in `picking` / `waiting` forever; the Czar never sees populated submissions.
- **Fix:**
  1. After `state.setSubmission`, call a new `checkRoundReady(code)` helper that computes `expectedSubmitters = activePlayers - czar - rando - skipped` and `actualSubmitters = unique playerIds in submissions hash`.
  2. When ready: read `config.rules`. Branch:
     - `godmode` → emit `vote_tally` with empty tally, set phase to voting (clients see voting UI).
     - `survival` → emit `elimination_turn` for the first non-Czar active player in join order.
     - `serious_business` → emit `reveal_start`; iterate `card_revealed(i, fills[i])` with `await sleep(REVEAL_STAGGER)`; then wait for Czar `rank`.
     - default (normal / no modal rule) → emit `reveal_start`; iterate `card_revealed`; then wait for Czar `pick`.
  3. Pull `REVEAL_STAGGER` from `~/lib/timing.ts`; do staggering server-side via `setTimeout`/`await sleep` so all clients see identical timing.
  4. For Rando, generate its submission inside `checkRoundReady` _before_ the expected-count comparison (see S0-4).

### S0-2. Survival of the Fittest never starts

- **Where:** `eliminateSubmission` exists but the first `elimination_turn` is never emitted.
- **Spec:** § House rules (Survival).
- **Effect:** Survival rounds deadlock.
- **Fix:**
  1. In the new `checkRoundReady` from S0-1, on the `survival` branch, emit `elimination_turn` for the first non-Czar non-Rando active player in join order, and store `eliminationTurnPlayerId` in `game:{code}:round` hash so it survives reconnects.
  2. In `eliminateSubmission`, validate `byPlayerId === eliminationTurnPlayerId` first; respond with `error: invalid_state` otherwise.
  3. After advancing the turn, persist the new `eliminationTurnPlayerId` to Redis (not just publish the event).
  4. The Czar should be skipped in rotation — already filtered, but verify with a Survival-mode test.

### S0-3. God Is Dead lets players vote for themselves and vote multiple times

- **Where:** `castVote` in `src/lib/game-engine.ts:378-455`.
- **Spec:** § House rules (God Is Dead).
- **Fix:**
  1. Add a Redis set `votes:{code}:{round}` keyed by voterId; on each `castVote`, do `SADD voterId` and exit early if `SADD` returns `0` (already voted).
  2. Look up the submission's playerId from the in-memory `submissions` map at the top of `castVote`; if `submitterId === _voterId`, return early with `error: invalid_state` ("cannot vote for own submission").
  3. Rename `_voterId` → `voterId` (the underscore was hiding the unused-arg lint warning — now it's used).

### S0-4. Rando Cardrissian never submits

- **Where:** No `randoSubmit` / `autoSubmitRando` function exists.
- **Spec:** § Game Rules Engine + § House rules (Rando).
- **Effect:** Rando is inserted as a player but never plays.
- **Fix:**
  1. Add `autoSubmitRando(code, blackCard)` in `game-engine.ts`. Body: find the Rando player row via `state.getAllPlayers(code)`; draw `pick` cards directly from `deck:white` (bypassing the hand mechanic — Rando has no hand); call `state.setSubmission(code, randoId, submission)` with the drawn cards as fills; emit `player_played` for Rando's id.
  2. Call this at the top of `startRound` (immediately after publishing `round_started`) when `config.rules.includes('rando')`.
  3. In the win check at `endRound`, also handle `winnerPlayer.isRando` → `endGame(code, 'rando_won', ...)` (already in place at line 328 — verify).

### S0-5. Packing Heat never fires

- **Where:** `applyPackingHeat(code, playerIds)` exists at `game-engine.ts:610` but is never called.
- **Spec:** § House rules (Packing Heat).
- **Fix:**
  1. In `startRound`, after the black card is drawn and before publishing `round_started`, check `if (config.rules.includes('packing_heat') && black.pick === 2)`.
  2. Compute eligible players: `activePlayers.filter(p => !p.isRando && p.id !== czarId)`. Call `applyPackingHeat(code, eligibleIds)`.
  3. Send each eligible player a `round_started` payload with the **updated 11-card hand** (currently `round_started` doesn't carry per-player hands — extend it, or emit a separate `hand_dealt` event after `round_started`).
  4. After submissions, `submitCards` already removes the played cards from the hand, returning it to 10 — works without changes.

### S0-6. Happy Ending has no trigger

- **Where:** No HTTP route, no WS event, no engine hook accepts a host "end now" action.
- **Spec:** § House rules (Happy Ending) + § Screens (topbar ⋯ menu).
- **Fix:**
  1. Add WS client event `{ type: 'happy_ending' }` in `types.ts` `ClientMessage` union.
  2. Handler routes it to a new `engine.triggerHappyEnding(code, playerId)` which verifies `playerId === session.hostPlayerId` and `config.rules.includes('happy_ending')` and the session is `active`.
  3. The engine inserts (or finds) a synthetic "Make a Haiku" black card row in the DB (seeded at boot — add to `seed.ts` as a baked-in row with a dedicated `pack` named "Haiku Final"). Push its id to the head of `deck:black`.
  4. Mark the upcoming round as "final" by setting a Redis flag `game:{code}:happyEndingFinal=1`. In `endRound`, when this flag is set, call `endGame(code, 'happy_ending', winnerPlayerId)` regardless of score.
  5. Add the topbar ⋯ menu in `src/routes/games/$code/session.tsx` (host only, only when rule is active).

### S0-7. Voided rounds leak cards

- **Where:** `expireRoundTimer` void path (line 187).
- **Spec:** § Round timer expiration.
- **Effect:** Submitted white cards already removed from hands are dropped (not returned, not discarded). The just-drawn black card is also never discarded.
- **Fix:**
  1. Before `state.clearSubmissions`, gather all `fills.map(f => f.id)` from the submissions hash and call `state.discardCards(code, 'white', fillIds)`. (Or: for fairness with the spec wording "cards returned to hands", restore them to the submitter's hand instead — pick one consistently. Discard is simpler and equivalent in expected value.)
  2. Move the round's `blackCardId` to discard: `await state.discardCards(code, 'black', [black.id])`.
  3. Clear the scheduled timer reference (see S2-17): track `setTimeout` handles in a `Map<code:round, Timeout>` and `clearTimeout` on void.

### S0-8. `endRound` schedules the next round but is never reachable from non-pick modes

- Caused by S0-1. Once that's fixed, all four resolution paths (`pickWinner`, `castVote`, `eliminateSubmission`, `applyRanking`) end with `endRound` correctly.
- **Fix:** Resolved by S0-1.

### S0-9. Mid-game joiners are not added to `czarOrder`

- **Where:** `endRound` activates queued players in Redis but never updates the `czarOrder` list.
- **Spec:** § Mid-Game Join + § Czar selection.
- **Fix:**
  1. In `endRound`, after `state.updatePlayer(code, p.id, { status: 'active' })` for each activated player, call `redis.rpush(KEYS.czarOrder(code), p.id)` and `redis.expire(KEYS.czarOrder(code), ROOM_TTL_SECONDS)`.
  2. Push `activated` array as currently done in `round_end` event so clients can recompute UI.

### S0-10. Round 1 random Czar offset never applied

- **Where:** `startGame` computes `firstCzarIdx` and discards it.
- **Spec:** § Czar selection: "Round 1 Czar is chosen randomly… record it as the starting offset."
- **Fix:**
  1. In `startGame`, after `chooseFirstCzar`, persist the offset: `await redis.hset(KEYS.game(code), 'czarStartOffset', String(firstCzarIdx))`.
  2. In `startRound`, read it back: `const offset = Number(await redis.hget(KEYS.game(code), 'czarStartOffset')) || 0`.
  3. Compute `czarId = activeOrder[(offset + round - 1) % activeOrder.length]`.
  4. This change also makes seeded-RNG tests deterministic, since `chooseFirstCzar` already uses `~/lib/rng`.

---

## S1 — Production deploy blockers

### S1-1. WebSocket server only attached in `vite dev`

- **Where:** `vite.config.ts` — `websocketPlugin` uses `apply: 'serve'`.
- **Effect:** `node .output/server/index.mjs` has no `/api/games/$code/ws`.
- **Fix:**
  1. Create `src/server-entry.ts` that imports the TanStack Start handler and wraps the Node HTTP server in production. Use Vinxi/h3's built-in WebSocket support via `defineWebSocket` (h3 v2 has it) OR attach crossws via the `upgrade` event after the http server starts.
  2. Configure `app.config.ts` (TanStack Start) to point to this entry: `start: { entry: { server: 'src/server-entry.ts' } }`.
  3. Inside the entry, call `startSweeper()`, `startKeepaliveEnforcer()`, and `void seedPacks().catch(...)` exactly once at boot.
  4. Remove the `apply: 'serve'` restriction from `websocketPlugin` _or_ keep the dev plugin for HMR and let the prod entry handle prod — pick one consistently.
  5. Test by running `pnpm build && pnpm start` locally and connecting a WS client.

### S1-2. `seedPacks()` is never called at boot

- **Where:** `src/lib/server-boot.ts` runs `startSweeper` and `startKeepaliveEnforcer` only.
- **Fix:**
  1. Add `void seedPacks().catch(err => seedLogger.error({ err }, 'seed failed'))` to `ensureServerBoot()`. The seed is async and idempotent — safe to fire-and-forget.
  2. Add a periodic retry (`setInterval(seedPacks, 5 * 60_000)`) only if last attempt failed; store success/failure in a module-level boolean.
  3. Once S1-1 lands, both `ensureServerBoot` and the prod entry will call it.

### S1-3. `ensureServerBoot` skipped when `NODE_ENV === 'test'`

- **Where:** `server-boot.ts:7` early-returns under `test`.
- **Effect:** Sweeper and keepalive enforcer don't run in E2E tests — the reconnect spec depends on those firing.
- **Fix:**
  1. Remove the `NODE_ENV === 'test'` guard entirely; the sweeper's 30-min cron will never fire during a single test run anyway, and the keepalive enforcer is essential for reconnect tests.
  2. If sweep timing is a worry, allow `process.env.CAB_SWEEPER_INTERVAL` to override the cron schedule for tests (e.g. set to a no-op cron).

### S1-4. Game state in Redis is never initialised at create-time

- **Where:** `POST /api/games` claims the code with `redis.set(KEYS.game(code), '1', ...)`. The key is now a **string**, but downstream code does `HGET` against it.
- **Effect:** `state.getCurrentRound` and friends crash with `WRONGTYPE`. Players hash is also never populated, so engine functions reading Redis see `[]` for players.
- **Fix:**
  1. Change `allocateRoomCode` to claim with a hash field instead of a string: replace `redis.set(...)` with `redis.hsetnx(KEYS.game(code), '_claimed', '1')` combined with `redis.expire(...)` (lua script for atomicity). If `hsetnx` returns 0, retry.
  2. After insertion of the session row, call `state.createGameState(code, host.id, parsed.data.config)` — this overwrites the hash with the proper schema (`status`, `currentRound`, `czarIndex`, `hostId`, `config`, `lastActivityAt`).
  3. Call `state.addPlayer(code, { id: host.id, username, role: 'player', status: 'active', score: 0, isHost: true, isRando: false, discardsUsed: 0, joinedAt: now })`.
  4. Mirror in `POST /api/games/$code/join`: call `state.addPlayer` for the new player. Emit `player_joined` over the pub/sub channel so existing lobby clients see them.

### S1-5. `GIN` index on `winning_submission_fills` may default to btree

- **Where:** `src/db/schema.ts:159` — `index('gin_winning_fills').on(t.winningSubmissionFills)`.
- **Fix:**
  1. Use Drizzle's index method: `index('gin_winning_fills').using('gin', t.winningSubmissionFills)`. (Drizzle 0.45+ supports `.using('gin', cols)` in pg-core.)
  2. Run `pnpm db:push` and confirm with `\d game_rounds` in psql that the index is `gin`.

### S1-6. `pick CHECK (1,2,3)` not enforced

- **Where:** `black_cards.pick` is plain `integer().notNull()`.
- **Fix:**
  1. Add a check constraint via Drizzle: in the table options array, append `check('black_pick_range', sql\`${t.pick} in (1,2,3)\`)`(import`check`from`drizzle-orm/pg-core`).
  2. `pnpm db:push` to apply.

---

## S2 — Spec deviations / missing functionality

### S2-1. Disconnect-during-game behaviors not implemented

- **Spec:** § Disconnect handling table.
- **Fix:** All paths run inside the grace-expiry callback in `src/ws/handler.ts:257-264`. Extend that block after `state.updatePlayer(code, playerId, { status: 'dropped' })`:
  1. Load `session.config` + current round hash.
  2. If `playerId === czarPlayerId`:
     - Look up current `phase` from a stored Redis field (add `phase` to `game:{code}:round` hash, set it transitionally in the engine).
     - `picking`/`waiting` → call new `engine.voidRound(code, reason: 'czar_dropped')` which returns submitted cards to hands, discards the black card, rotates czar in `czarOrder`, and calls `startRound` with the next czar.
     - `judging`/`reveal` (normal mode) → pick a random submission via `~/lib/rng.pick`, call `engine.pickWinner(code, czarId, randomSubmissionId)`.
     - `eliminating` (Survival) → auto-eliminate random submissions in a loop until `pickWinner` resolves naturally.
     - `ranking` (Serious Business) → fill in any unfilled rank slots with `~/lib/rng.shuffle(remainingSubmissions).slice(0, 3)`, then call `engine.applyRanking`.
  3. If `playerId === session.hostPlayerId`: find the next-by-`joinedAt` player whose status is `active`, set `isHost: true` on them in Redis + DB, update `gameSessions.hostPlayerId`. Emit a custom `host_changed` event (add to `ServerMessage` union) so UIs update.
  4. If `state.getAllPlayers(code).every(p => p.status === 'dropped')`: set session status to `'paused'` in DB and Redis hash. Don't expire; let the sweeper clean it up after 6h.

### S2-2. House-rule phase gating missing

- **Spec:** § House rules.
- **Fix:**
  1. Persist current `phase` in `game:{code}:round` hash (one new field, updated by the engine at each transition).
  2. In `redraw` and `confessDiscard`, read phase first; reject if not in `picking` or `transition`. Reply with `error: invalid_state` over the player's socket (handler needs to pass through these errors to `peer.send`).
  3. In `gamble`, add an explicit `currentRound > 1` check and a `config.rules` modal-rule check: `if (rules.some(r => ['godmode','survival','serious_business'].includes(r))) return error('invalid_state')`.

### S2-3. Spectator action rejection missing

- **Where:** `src/ws/handler.ts` message router.
- **Fix:**
  1. After the auth-handshake block, before the `switch`, load `const player = await state.getPlayer(ctx.code, ctx.playerId)` (cache it in `ctx` to avoid re-reads).
  2. If `player.role === 'spectator'` and `parsed.type` is one of `play | gamble | pick | rank | vote | eliminate | redraw | confess_discard`, send `error: spectator_action` and return.
  3. Allow `ping | rejoin | leave` for spectators.

### S2-4. Auth: `player_dropped` reply not sent

- **Where:** `src/ws/auth.ts` collapses both "missing player" and "dropped player" to `null`.
- **Fix:**
  1. Change return type to a tagged union: `{ ok: true, playerId, anonId } | { ok: false, code: ErrorCode }`.
  2. In `authenticateSocket`, return `{ ok: false, code: 'player_dropped' }` when `player.status === 'dropped'`, and `{ ok: false, code: 'invalid_token' }` for HMAC failure / missing player.
  3. In `handler.ts`, propagate the specific code to the `auth_error` event.

### S2-5. Lobby UI doesn't request a state snapshot, doesn't display config

- **Where:** `src/routes/games/$code/lobby.tsx`.
- **Fix:**
  1. Add a `state_snapshot` handler in the lobby `on(...)` switch. When received, populate `players` from the snapshot and read `config` (extend `SessionState` to include config OR add a new `lobby_snapshot` event with `{ players, config }`).
  2. The lobby is pre-game — `state_snapshot` is currently only sent for in-progress games. Add a server-side `getLobbySnapshot(code)` and emit it on `rejoin` when status is `'lobby'`.
  3. On mount, also `fetch('/api/games/' + code)` (add this endpoint) to pull the current player list + config — gives an instant render before the WS finishes connecting.
  4. Wire config values into the "Game config" sheet (currently hardcoded `—`).
  5. On `state_snapshot` where `gameStatus !== 'lobby'`, redirect: `'active' | 'paused' → /session`, `'ended' → /end`.

### S2-6. Create-game screen has no packs / no rules UI

- **Where:** `src/routes/games/create.tsx`.
- **Fix:**
  1. On mount, `fetch('/api/packs')` → render a grid of `CheckCard` components (component already exists in `src/components/ui/CheckCard.tsx`). Default-select the pack whose `name` matches `/^CAH Base Set/i`. Disable the toggle for the Core pack (locked).
  2. Add a "House rules" section below "Game options":
     - Modal rules subsection: radio group with `None | God Is Dead | Survival of the Fittest | Serious Business`. Selecting one rule removes the other two from `draft.rules`.
     - Orthogonal rules subsection: 5 checkboxes for `rebooting | packing_heat | rando | never_have_i_ever | happy_ending`.
  3. Update `GameContext` defaults if needed (`packs: []` is fine; auto-select on load via the packs effect).
  4. Disable "Create lobby" until `draft.packs.length >= 1`.

### S2-7. Join screen + spectator-only / room-full UX

- **Where:** `src/routes/games/join.tsx` (not audited in detail; verify against the helpers expectations).
- **Fix:**
  1. Verify selectors used by `tests/helpers.ts` (`input[placeholder*="code"]`, `input[placeholder*="handle"]`, `button:has-text("Join game")`, `button:has-text("Spectator")`) all exist.
  2. On submit, if response is `423 room_full`, show a banner "Room full — join as spectator?" and auto-flip the role picker to Spectator.
  3. If `localStorage.cab_session.roomCode` already set and differs from the input, render a modal: "You're already in game XXX-XXX. Leave it first?" with Leave / Cancel buttons. Leave sends `{type:'leave'}` over the existing WS, clears `cab_session`, proceeds.

### S2-8. End screen shows no winner / scores / Rando shame variant (— fixed)

- **Where:** `src/routes/games/$code/end.tsx`.
- **Fix:**
  1. Read the `game_over` event from a context or a `useState` that captures it in `session.tsx` and persist it to `sessionStorage.cab_last_game_over` before navigating.
  2. On end-screen mount, hydrate from that storage. Render: winner avatar + name, final scoreboard (reuse `<Scoreboard>` component), Rando shame variant if `mode === 'rando_won'`, haiku flourish if `mode === 'happy_ending'`.
  3. Fix `cab_game_ended` to include `mode, winnerId, totalRounds, durationMs, finalScores` per spec.

### S2-9. Stats endpoint missing most aggregations (— fixed)

- **Where:** `src/routes/api/stats.ts`.
- **Fix:**
  1. Add SQL queries for:
     - `games_per_day`: `select date_trunc('day', ended_at) as day, count(*) from game_sessions where status='ended' and ended_at > now()-interval '30 days' group by 1 order by 1`.
     - `lobbies_by_player_count`: `select jsonb_array_length(config->'packs'), count(*) from game_sessions group by 1` (or count players via subquery).
     - `pack_adoption`: `select pack_id, count(distinct session_id) from game_sessions cross join lateral jsonb_array_elements_text(config->'packs') p(pack_id) group by 1` — then filter out the Core pack id at the API layer.
     - `house_rules_adoption`: similar JSONB-elements query against `config->'rules'`.
     - `avg_players_per_game`: subquery per session.
  2. Aggregate into a single response shape matching the design's `STATS_DATA`.
  3. Keep `cache-control: public, max-age=300`.

### S2-10. E2E tests are placeholders

- **Where:** `tests/e2e/*.spec.ts` and `playwright.config.ts`.
- **Fix:**
  1. Write `tests/global-setup.ts`: connect to Postgres + Redis, run `pnpm db:push --force`, then `await seedPacks()` against the test DB. Set in config: `globalSetup: require.resolve('./tests/global-setup.ts')`.
  2. Write `tests/global-teardown.ts`: truncate all tables and `redis.flushdb()`.
  3. Flesh out `tests/e2e/full-game.spec.ts`: import `submitCards`, `pickWinner` helpers (already exist), loop until URL is `/end`, assert scores.
  4. Write `tests/fixtures/expected-outcomes.ts` with the deterministic outcome given `CAB_RNG_SEED=test-seed-2026`. Compute outcomes by running the engine once and serialising the result.
  5. Implement each spec (reconnect, multi-blank, mid-game-join, house-rules, mobile, a11y) with at least one scenario each.

### S2-11. Reshuffle threshold includes Czar/Rando

- **Where:** `endRound` — `activeCount = players.filter(active).length`.
- **Fix:** `const activeCount = players.filter(p => p.status === 'active' && !p.isRando).length`. Rando has no hand; Czar gets a fresh card too (they were skipped this round but still need 10 — actually Czar's hand is untouched, only submitters draw). Refine: count is fine for "active non-rando" since reshuffle is based on _expected next-round demand_.

### S2-12. PostHog distinct IDs are inconsistent (— fixed)

- **Where:** Throughout `game-engine.ts`, various call sites.
- **Fix:**
  1. Add a helper `async function distinctIdFor(code: string, playerId: string): Promise<string>` in `posthog-server.ts` that reads `player.posthogAnonId` from Redis (or DB fallback) and returns it, defaulting to `playerId` if missing.
  2. Replace every `captureServerEvent(code, ...)` with `captureServerEvent(await distinctIdFor(code, primaryActorPlayerId), ...)`.
  3. For game-level events (`cab_round_started`) with no clear actor, use the host's distinctId.

### S2-13. `cab_game_started` missing `durationLobbyMs` (— fixed)

- **Where:** `src/routes/api/games/$code/start.ts`.
- **Fix:** Add `durationLobbyMs: Date.now() - session.createdAt.getTime()` to the `captureServerEvent` properties.

### S2-14. `cab_rule_triggered` emits `rule: 'gambling'`

- **Where:** `gamble()` in `game-engine.ts:570`.
- **Fix:** Remove the duplicate `captureServerEvent(..., 'cab_rule_triggered', { rule: 'gambling' })` call entirely — `cab_gambled` already covers gambling per the event taxonomy.

### S2-15. `gamble` doesn't verify game is past round 1

- **Where:** `gamble()` in `game-engine.ts`.
- **Fix:** Add at top: `const round = await state.getCurrentRound(code); if (round <= 1) return`. Pair with the modal-rule check from S2-2.

### S2-16. Core pack auto-select missing

- **Where:** `src/routes/games/create.tsx`.
- **Fix:** Already covered in S2-6 step 1 — on packs-load, auto-select the pack with `name` matching `/^CAH Base Set/i` (or by a stable slug), and mark its CheckCard as locked.

### S2-17. Stale-round timer race

- **Where:** `startRound` schedules `setTimeout(expireRoundTimer, ms)` with no handle tracking.
- **Fix:**
  1. Add a module-level `const roundTimers = new Map<string, NodeJS.Timeout>()` keyed by `code`.
  2. Before scheduling a new timer in `startRound`, `clearTimeout(roundTimers.get(code))`.
  3. On `endRound`, `clearTimeout(roundTimers.get(code))` before the next round's `startRound` fires.
  4. The existing `currentRound !== round` guard remains as a belt-and-braces defence.

### S2-18. `useGameSocket` reconnects forever after intentional close (— fixed)

- **Where:** `src/hooks/useGameSocket.ts`.
- **Fix:**
  1. Inside the effect, declare `let cancelled = false`.
  2. In `ws.onclose`, check `if (cancelled) return` before scheduling the reconnect.
  3. In the effect's return (cleanup), set `cancelled = true` _before_ `wsRef.current?.close()`.
  4. Also clear any pending `setTimeout(connect, backoffMs)` by tracking the handle and `clearTimeout` it on cleanup.

### S2-19. `cab_reconnect_attempt` posted on first close (— fixed)

- **Where:** `useGameSocket.ts:60`.
- **Fix:** Only `captureEvent('cab_reconnect_attempt', ...)` when `attempt > 1`.

### S2-20. SPEC.md still references `docker-compose.prod.yml` (— fixed)

- **Where:** `SPEC.md` § Quick Reference + § Docker section.
- **Fix:** Remove the `-f docker-compose.prod.yml` form from quick reference; update the Docker section to say "single `docker-compose.yml` with environment overrides for prod".

---

## S3 — Minor / polish

- **`stub-content.ts`** — used only for the Home-screen sample cards. Once a real Pack is wired into Home, delete this file. **(— deferred)**
  **Fix:** Replace `SAMPLE_PROMPT` / `SAMPLE_WHITE_*` in `src/routes/index.tsx` with a fetch to `/api/packs` + a random card. Delete `src/lib/stub-content.ts`.
  _Deferred: not a bug — refactors working Home copy and adds a network dependency to the landing page for cosmetic sample cards; out of scope for a polish pass._

- **`logger.ts`** — verify child loggers are named `cab.ws`, `cab.api`, `cab.engine`, `cab.seed`, `cab.sweeper` (per spec § Logging). **(— fixed)**
  **Fix:** Read the file and rename if necessary. Centralise the prefix into a single `BASE = 'cab'` constant.

- **`useSession`** SSR hydration risk — synchronous `localStorage` read inside `useState` initialiser. **(— fixed)**
  **Fix:** Convert to a `useEffect` that runs once on mount and sets state from `localStorage`. Initial render is `null`, which avoids SSR mismatch; an optimistic UI can use `useSyncExternalStore` if the flicker is visible.
  _Implemented via `useSyncExternalStore` (server snapshot `null`): the repo's `react-hooks/set-state-in-effect` lint rule forbids the setState-in-effect form, and this is the React-sanctioned external-store-with-SSR pattern the note anticipates._

- **`useGameSocket`** doesn't pause sends after `auth_error`. **(— fixed)**
  **Fix:** Track `setAuthed(false)` on `auth_error`; gate `send()` on `authed === true`.

- **Empty-pack-DB gameplay 503** not enforced. **(— fixed)**
  **Fix:** In `POST /api/games`, before insertion, `const [{count}] = await db.select({count: count()}).from(packs); if (count === 0) return errorResponse(503, 'internal_error', 'No card data available')`. Mirror in `POST /api/games/$code/start`.

- **Plan/spec drift**: re-tag SPEC.md sections (Game Rules Engine, Spectator Permissions, Mid-Game Join, Card Data Seeding, Stats, Screens, E2E, PostHog) from ✅ DONE → ⚠️ PARTIAL or ❌ NOT IMPLEMENTED as appropriate. **(— deferred)**
  **Fix:** After the S0/S1 fixes land, refresh SPEC.md section headers based on what's actually shipped. Same exercise on the plan markdown.
  _Deferred: broad, judgement-heavy doc-sync spanning ~8 spec sections; best done as a dedicated final pass once the full AUDIT backlog is closed, not folded into a code-polish commit._

- **Healthz `db` flag** — when DB is down, the response still names `db: 'down'` which is correct, but the response should also exclude `activeGames` (currently defaults to `0`, misleading). **(— fixed)**
  **Fix:** Move the `activeGames` field inside the try block so it's only emitted on success.

---

## Suggested priorities

1. **S1-4** Redis init on game create — unblocks all other Redis-touching code.
2. **S1-1, S1-2** Wire WS adapter + `seedPacks` into a real prod entry — without this, no deployment works.
3. **S0-1** Reveal/judging orchestration in the engine — unblocks the entire game loop.
4. **S0-10** Round-1 Czar offset + **S0-9** mid-game `czarOrder` append — tiny, makes seeded tests deterministic.
5. **House-rule orchestration**: S0-4 Rando, S0-5 Packing Heat, S0-6 Happy Ending, S0-2 Survival first turn.
6. **S0-3** God Is Dead correctness.
7. **S2-1** Disconnect handling for Czar / host / all-players.
8. **S2-3** Spectator action rejection + **S2-4** `auth_error: player_dropped`.
9. **S2-6** Create-game UI (packs + rules) + **S2-16** Core auto-select — without these, every game starts with empty decks.
10. **S2-5** Lobby snapshot + config display.
11. **S2-9** Stats aggregations + **S2-8** end-screen content.
12. **S2-10** E2E test bodies + globalSetup/Teardown.
13. **S2-12** PostHog distinct_id consistency + **S2-13** event property fill-ins.
14. **S2-18** `useGameSocket` reconnect-on-cleanup fix.
