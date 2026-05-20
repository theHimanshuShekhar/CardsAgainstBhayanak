# Cards Against Bhayanak — Implementation Audit

_Generated 2026-05-20. Fresh re-audit of `main` at `47e1d85` (post Phase 1 + Phase 2 of the 2026-05-19 gameplay-fixes batch), cross-referenced against [`SPEC.md`](./SPEC.md), [`CLAUDE.md`](./CLAUDE.md), and `docs/superpowers/specs/2026-05-19-gameplay-fixes-batch-design.md`. Every finding below was re-verified against the source at the `file:line` cited — this audit supersedes the 2026-05-18 sweep._

## Severity scheme

| Sev    | Meaning                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| **S1** | Correctness / integrity / cheat-vector in a core flow. Game still runs but produces wrong or exploitable results. |
| **S2** | Spec deviation. Game progresses, but behaviour disagrees with `SPEC.md`/`CLAUDE.md`.                              |
| **S3** | Robustness / polish / minor deviation. Low player impact.                                                         |

## Scope note — cheating deferred

Anti-cheat / adversarial-client hardening remains **out of scope** (trusted-client, play-with-friends MVP). Six findings (S1-3, S1-4, S2-2, S2-3, S2-4, S3-4) whose only impact is "a crafted client could cheat" stay tagged **`[DEFERRED — cheating out of scope]`** and are excluded from the active priority list.

## Status legend

- `[FIXED ≤ 2026-05-19]` — closed before this audit; verified still fixed against current source.
- `[OPEN]` — present in current code; covered in the priority list at the bottom.
- `[DEFERRED — cheating out of scope]` — see scope note.

## TL;DR

The game is end-to-end playable, **49/49 Playwright E2E + 24/24 vitest** are green on `47e1d85`, and the entire 2026-05-18 audit minus the six deferred cheating items has been resolved (with three prod-observation patches piled in on 2026-05-19 — round-result pause, ghost score chips, czar's own points).

The new sweep surfaces:

- **One sleeping S1**: `game_sessions.last_activity_at` is set at row insert and **never updated** — the 6-hour stale-game sweeper currently abandons every active or paused game six hours after creation, regardless of activity. Silent in tests (E2E never sleeps 6h), latent in prod (any game that runs >6h disappears mid-play).
- **One S2 process-locality regression**: `restoreRoundTimers` was added for `picking`, but `reveal` (`REVEAL_STAGGER` loop) and the post-resolve `ROUND_RESULT_PAUSE_MS` `await sleep` are still in-process. A restart during reveal/transition permanently stalls that round.
- **A handful of S3 polish gaps** introduced by Phase 2 (reset stale-timer collisions, missing client handlers for `round_voided` / `game_reset` on `/session`, lobby config edits unbounded by current roster, `prefers-reduced-motion` not honoured by the new `.stage-timer-urgent` blink).

Cheating items are unchanged in scope (still deferred). The original Phase 1 / Phase 2 design intent for the 9 reported issues is implemented and verified.

---

## S1 — Correctness / integrity

### S1-NEW · `gameSessions.last_activity_at` is never refreshed — sweeper abandons every active/paused game 6h after creation `[OPEN]`

- **Where:** `src/db/schema.ts:99` (`lastActivityAt … defaultNow()`); `src/lib/sweeper.ts:15` (`<  now() - interval '6 hours'`); no `UPDATE gameSessions SET lastActivityAt = …` anywhere in `src/`.
- **Spec:** `SPEC.md` § Stale game sweeper / `CLAUDE.md` schema — the column is meant to be the heartbeat the sweeper compares against (`refreshed on mutation`). Comment in `game-state.ts:16` writes the Redis-mirror `lastActivityAt`, but nothing propagates to Postgres.
- **Bug:** A grep over `src/` finds exactly three `lastActivityAt` callsites: the schema default, the Redis-mirror write at room creation, and the sweeper's WHERE clause. No code path ever writes `gameSessions.lastActivityAt` after row insert. Combined with the partial index on `(active, paused)`, every game whose `createdAt = lastActivityAt` is now older than 6 hours is matched by the sweeper. Since the Redis-players hash empties out **during** a long game (each player closes their tab between sessions, etc.) — and the sweeper only checks `hlen(KEYS.players) == 0` to actually abandon — this is _latent_ unless the player roster also empties. But the moment a deserted-and-rejoined-and-played-out game crosses 6h (or a paused game does, which is the entire point of pause), the sweeper will flag it.
- **Impact:** A genuine long session (one running 6h+ during a party, say) risks being abandoned out from under players. A paused-and-then-resumed game is at much higher risk because the players hash transiently went to zero before resume — though the sweeper checks `hlen == 0` so a resumed game with active players survives. Net: combined with the sweeper's hlen guard this fires only in narrow conditions, but the fundamental column-not-refreshed defect is real and will compound with any future logic that trusts `lastActivityAt`.
- **Fix sketch:** On every meaningful mutation (round start, submission, host action, join/leave) — or, cheaper, on every WS auth + every round_started — `UPDATE gameSessions SET lastActivityAt = now() WHERE code = ?`. Alternatively, derive the sweeper predicate from `redis.hget(KEYS.game(code), 'lastActivityAt')` (already kept fresh) and stop relying on the DB column.

### S1-1 · Winning gambler scoring — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/game-engine.ts:1114-1123` (`settleGambles` debits non-winning gamblers at resolve time, skips the winner), `:605-606` (`pickWinner` reads `winner.score` before settling and credits `+1 + transfer`). Wager is no longer debited at `gamble()` time.

### S1-2 · Stable Czar rotation — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/game-engine.ts:189-202` — traversal of the stable `czarOrder` with a `dropped` skip-forward; modulus is taken over `order.length`, never the live filtered list.

### S1-3 · No Czar authorization on `pick` / `rank` — `[DEFERRED — cheating out of scope]`

- Still present at `src/ws/handler.ts:334-345`. The trusted-client MVP scope leaves this in place.

### S1-4 · `submitCards` doesn't validate ownership or pick count — `[DEFERRED — cheating out of scope]`

- Still present at `src/lib/game-engine.ts:522-557`. Deferred.

---

## S2 — Spec deviations

### S2-NEW · Reveal-loop and round-result pause are process-local — restart mid-reveal or mid-transition stalls the round `[OPEN]`

- **Where:** `src/lib/game-engine.ts:488` (`await sleep(REVEAL_STAGGER)` per card in `checkRoundReady`), `:741` (`await sleep(roundResultPauseMs())` in `endRound`), `:344-367` (`restoreRoundTimers` — only re-arms `picking` timers).
- **Spec:** `CLAUDE.md` non-negotiable: _"Server-controlled phase timing — clients never run their own phase timers."_ The intent is that _no_ phase progression depends on a single process surviving — analogous to the picking timer re-arm `S2-10` fix.
- **Bug:** The `picking` timer was correctly persisted to Redis (`roundTimerExpiresAt`) and re-armed on boot (`restoreRoundTimers`). The other two engine-driven sleeps — the staggered reveal loop and the post-resolve hold — are pure `await sleep` chains inside the Node process. A restart during the reveal sequence loses the remaining `card_revealed` frames; a restart during the post-resolve hold never publishes the next `round_started`. In both cases the round is permanently stuck because the snapshot exposes `phase = reveal|transition` to a reconnecting client but no engine code resumes the loop.
- **Impact:** A mid-deploy crash on any round that's past `checkRoundReady` strands the room.
- **Fix sketch:** Persist the resume points (e.g. `revealCursor`, `transitionDoneAt`) and add boot-time helpers next to `restoreRoundTimers` that, for each room in `reveal` / `transition`, push the remaining frames / fire `endRound`'s continuation. Or push the reveal loop into a small queue that survives restarts (e.g. a Redis stream).

### S2-1 · Timer-void white-card leak + black-card discard — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/game-engine.ts:310-329` calls `returnRoundCards(code, roundRow.blackCardId)` before clearing submissions; `returnRoundCards` (`:900-910`) pushes each fill back to its submitter's hand and discards the black card.

### S2-2 · No server enforcement of mode-specific resolution actions — `[DEFERRED — cheating out of scope]`

### S2-3 · `gamble` not gated to round ≥ 2 / normal mode — `[DEFERRED — cheating out of scope]`

### S2-4 · `redraw` / `confess_discard` lack phase + rule-enabled gates — `[DEFERRED — cheating out of scope]`

All three still present (`game-engine.ts:1328-1365`, `:1367-1380`, `:1382-1402`).

### S2-5 · WS `leave` — `[FIXED ≤ 2026-05-19]`

### S2-6 · `POST /api/games/$code/leave` — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/ws/handler.ts:355-361` (immediate `engine.dropPlayer(..., 'leave')`, peer removed, close handler short-circuits on `status === 'dropped'`), `src/routes/api/games/$code/leave.ts:9-16` (HTTP path delegates to the same `dropPlayer`). `dropPlayer` (`game-engine.ts:1046-1096`) runs the canonical void/migrate/pause path and is idempotent.

### S2-7 · `conflicting_rules` validation — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/api-helpers.ts:47-51` (`conflictingModalRules` shared helper); `src/routes/api/games/index.ts:57-66` (create); `src/routes/api/games/$code/config.ts:32-39` (lobby PATCH). The same `400 conflicting_rules` is emitted from both endpoints — the shared helper guarantees create and PATCH cannot diverge.

### S2-8 · Paused-game resume — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/game-engine.ts:1010-1038` (`resumeIfReady` activates ≥3 humans, flips `paused → active`, voids the stuck round so a present player can re-czar); `join.ts:71-117` calls it on a paused-room join.

### S2-9 · Reconnect snapshot fidelity — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/ws/handler.ts:101-136` reads persisted phase, `winnerId`, `eliminationTurnPlayerId`, `ranking`, `voteTally`, `roundTimerExpiresAt`. The submission-count phase heuristic is now a defensive fallback only.

### S2-10 · Round timer restore on restart — `[PARTIAL — see S2-NEW above]`

- The `picking` re-arm is correctly implemented in `restoreRoundTimers` (`:344-367`) and called from `src/lib/server-boot.ts`. The remaining process-local sleeps (reveal stagger, round-result pause) make this an incomplete fulfilment of the original `CLAUDE.md` non-negotiable — split out as **S2-NEW** above.

### S2-11 · Atomic `updatePlayer` — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/game-state.ts:34-56` — the per-field merge is now a Lua script (`UPDATE_PLAYER_LUA`) executed atomically on the players hash; every concurrent score/status/gamble write applies against the latest committed value.

### S2-12 · Round outcomes persisted to `gameRounds` — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/game-engine.ts:638-662` (`persistRoundOutcome`), called from all four judged-resolution funnels (`:623`, `:1201`, `:1254`, `:1318`). Voided rounds correctly bypass it. `src/routes/api/stats.ts:35-39` now scopes "Rounds judged" to ended sessions + `isNotNull(winnerPlayerId)`.

### S2-13 · Round-result flash — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/timing.ts` (`ROUND_RESULT_PAUSE_MS = 4000`), `game-engine.ts:741` (server-side `await sleep(roundResultPauseMs())` between `round_end` and the next `round_started` / `game_over`), `session.tsx:120-132` (no client `WINNER_PAUSE` timer; board stays on resolved round until the delayed `round_started`). E2E shrinks via `CAB_ROUND_RESULT_PAUSE_MS`.

### S2-14 · Phantom dropped-player chips — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/lib/game-engine.ts:34-44` (`toPlayerScores` excludes `dropped`, keeps `grace`); used at every scores-emitting funnel (`:609`, `:769`, `:1186`, `:1241`) and at `src/ws/handler.ts:71`. Unit-tested in `src/lib/game-engine.test.ts:38-81`.

---

## S3 — Robustness / polish

### S3-NEW-A · Stale `expireRoundTimer` setTimeout from a prior reset can fire on a new game's same-numbered round `[OPEN]`

- **Where:** `src/lib/game-engine.ts:267-274` — guard is `if (currentRound !== round) return`.
- **Bug:** `resetGame` (`:798-894`) wipes Redis but cannot cancel in-process `setTimeout`s scheduled by a previous game. If game 1 ran 5 rounds and the host hits _Rematch_, the round-5 setTimeout is still pending. Most pending timers will harmlessly no-op because `currentRound` has rotated past their `round` argument — _unless_ the new game happens to be on the same round number with a still-running timer (e.g. game 1's round 3 timer fires while new game is also on round 3 and the player hasn't submitted yet → triggers a spurious skip path).
- **Impact:** Narrow but real. A timer-driven skip / void fires on the wrong round under specific timing.
- **Fix sketch:** Compare against a monotonic "round instance id" (e.g. the `roundTimerExpiresAt` itself, captured in the closure) — bail unless `await state.getRoundTimerExpiresAt(code) === thisExpiry`.

### S3-NEW-B · `session.tsx` ignores `round_voided` and `game_reset` `[OPEN]`

- **Where:** `src/routes/games/$code/session.tsx:55-153` — handlers cover `state_snapshot`, `round_started`, `hand_update`, `player_played`, `player_skipped`, `reveal_start`, `card_revealed`, `round_won`, `round_end`, `game_over`, `auth_error`. Nothing for `round_voided` or `game_reset`.
- **Impact:**
  - On `round_voided` (timer-void with <2 submitters, or czar-dropped): the player sees the board silently reset with no toast. They had submitted; their card is back in their hand. This is jarring UX.
  - On `game_reset`: the in-flight session UI never receives it because the user has already navigated to `/end` by `game_over` time — but a race window exists (slow navigate / browser back / fast-clicking host). A `game_reset` arriving on `/session` should explicitly route to `/games/$code/lobby`.
- **Fix sketch:** Add both handlers. `round_voided` → toast/banner with `event.reason`; `game_reset` → `navigate('/games/$code/lobby')`.

### S3-NEW-C · `lobby.tsx` PATCH `/config` is not bounded by the current roster `[OPEN]`

- **Where:** `src/routes/api/games/$code/config.ts:28-46`, `src/components/game/GameConfigEditor.tsx:93-109`.
- **Bug:** The lobby host can shrink `maxPlayers` from e.g. 8 to 3 while 7 players are already in the lobby. The PATCH only validates `min(3)..max(10)` and modal-rule exclusivity; it does not compare against the current active player count. New joiners are correctly blocked at `join.ts:56-57`, but the overcap roster remains. Similarly, dropping the `rando` rule mid-lobby is silently fine because Rando isn't created until `startGame`, but the inverse (`packs: []`) is blocked only by the schema's `.min(1)`.
- **Impact:** UX gap. The "Start game" button still works with the 7-player roster because `canStart` only checks `>= 3`. But the game launches with `config.maxPlayers = 3` and 7 players seated — a mid-game drop would leave a join attempt blocked by a number the host already exceeded.
- **Fix sketch:** In the PATCH handler, count active non-dropped players and reject `maxPlayers < count` with a clear message; mirror in `GameConfigEditor` by disabling the stepper at the current count.

### S3-NEW-D · `.stage-timer-urgent` blink animation ignores `prefers-reduced-motion` `[OPEN]`

- **Where:** `src/styles.css:1511-1513` (`@keyframes blink` at `:1443`); the `prefers-reduced-motion` block at `:956-960` covers only `.home-card-cycle`.
- **Impact:** Players with reduced-motion preferences still see the timer flash from `< 10s`. Minor accessibility deviation from a documented project pattern (the home-card-cycle handles it).
- **Fix sketch:** Extend the `prefers-reduced-motion` block to disable `animation` on `.stage-timer-urgent` (and on the live `.dot.live` at `:1435` for consistency).

### S3-NEW-E · `cab_last_game_over` sessionStorage never explicitly cleared `[OPEN]`

- **Where:** `src/routes/games/$code/session.tsx:138-147` writes it on `game_over`; `src/routes/games/$code/end.tsx:23-33` reads it; no consumer clears it.
- **Impact:** After a _Back to lobby_ + a new game that never finishes (room left mid-play, browser refresh on `/end`), a stale `cab_last_game_over` lingers and a stray `/end` visit would render the _previous_ game's result. Low-probability.
- **Fix sketch:** Clear on `end.tsx`'s "Go home" and "New room" handlers, and on `lobby.tsx` mount when `gameStatus === 'lobby'`.

### S3-NEW-F · `gameSessions.hostPlayerId` and `winnerPlayerId` columns have no FK `[OPEN]`

- **Where:** `src/db/schema.ts:95-96` — `hostPlayerId: text('host_player_id')`, `winnerPlayerId: text('winner_player_id')`. Neither uses `.references(() => gamePlayers.id)`.
- **Spec:** `SPEC.md` / `CLAUDE.md` schema both annotate these as `(nullable) FK`.
- **Impact:** No data-integrity violations have been observed (the engine always sets coherent IDs and the chicken-and-egg note in `CLAUDE.md` is honoured), but the columns are weaker than the spec promises. The `gameRounds.czarPlayerId` / `winnerPlayerId` columns _do_ carry the FK (`schema.ts:150-151`), so the divergence is asymmetric and undocumented.
- **Fix sketch:** Either add `.references(() => gamePlayers.id)` (after ensuring `resetGame` clears `winnerPlayerId` before deleting Rando rows — currently safe because both Rando deletions happen after the round wipe), or update the spec to reflect that these are loose pointers by design.

### S3-1 · Room-code casing — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/ws/handler.ts:196-198` (regex now case-insensitive, normalises to upper), `join.ts:23`, `start.ts:14`, `leave.ts`, `reset.ts:22`, `config.ts:20` (all uppercase the param).

### S3-2 · Gamble point-transfer edges — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `settleGambles` (`game-engine.ts:1114-1123`) keys off `hasGambled`, not on the presence of a `:gamble` storage key. A single-submission or zero-submission gambler is now correctly debited and the wager transfers to the winner.

### S3-3 · `czarOrder` join order — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `game-engine.ts:104` (`.orderBy(gamePlayers.joinedAt)`); `:138` excludes Rando from `czarOrderIds`.

### S3-4 · Late `play` after reveal starts — `[DEFERRED — cheating out of scope]`

- Same gate would close it as S1-4 / S2-3 / S2-4. Deferred.

### S3-5 · Analytics payload deviations — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `cab_game_created` (`src/routes/api/games/index.ts:118-126`) emits `modalRule`; `cab_gambled` (`src/lib/game-engine.ts:1354-1359`) carries `round`.

### S3-6 · Czar's own points hidden — `[FIXED ≤ 2026-05-19]`

- **Verified at:** `src/components/game/Scoreboard.tsx:25` — `{isJudge ? \`JUDGE · ${pts}\` : pts}`. The Czar sees both the indicator and the score.

---

## Verification notes

- All file:line references verified against `47e1d85` (current `main`, `git status` clean).
- Unit tests: 24/24 vitest (`pnpm test`, env exported as documented in memory).
- E2E: 49/49 Playwright (`pnpm test:e2e`).
- `SPEC.md` and `CLAUDE.md` remain canonical for intended behaviour. The spec amendment in `docs/superpowers/specs/2026-05-19-gameplay-fixes-batch-design.md` (hand stored as ordered Redis list, not a set) is reflected at `src/lib/game-state.ts:135-152` and at `SPEC.md:826` / `CLAUDE.md:327`.
- **Coverage gap (pre-existing):** the suite has no protocol driver for _Survival of the Fittest_ or _Serious Business_. Their `persistRoundOutcome` callsites (`game-engine.ts:1254`, `:1318`) are typecheck-verified only. The new `S2-NEW` reveal/transition restart resilience is similarly untestable without a kill-and-restart harness.

## Suggested priority order

_Cheat-defense findings (S1-3, S1-4, S2-2, S2-3, S2-4, S3-4) remain deferred per the scope note._

1. **S1-NEW** `lastActivityAt` heartbeat — quietly resolves the only S1 hazard for honest play.
2. **S2-NEW** reveal/transition restart resilience — completes the `CLAUDE.md` server-controlled-phase-timing non-negotiable that S2-10 only partially fulfilled.
3. **S3-NEW-B** `session.tsx` handlers for `round_voided` + `game_reset` — closes the two highest-visibility UX races introduced by the void-card + reset flows.
4. **S3-NEW-A** stale-timer collision after reset — small change, real fix.
5. **S3-NEW-C** lobby PATCH config bounded by roster — host-only convenience but trivially fixable.
6. **S3-NEW-D** reduced-motion for the new urgent-timer blink.
7. **S3-NEW-E** clear `cab_last_game_over` on lobby/home transitions.
8. **S3-NEW-F** add (or formally retire from spec) the missing FKs on `gameSessions.{host,winner}PlayerId`.

> When anti-cheat comes back into scope, fold in at roughly: S1-3 / S1-4 first (round resolution & submission integrity), then S2-2 / S2-3 / S2-4 / S3-4 (mode/phase/rule gates).
