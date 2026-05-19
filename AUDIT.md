# Cards Against Bhayanak — Implementation Audit

_Generated 2026-05-18. Fresh audit of the current code on `main`, cross-referenced against [`SPEC.md`](./SPEC.md) and [`CLAUDE.md`](./CLAUDE.md). Every finding below was verified against the source at the file:line cited — not carried over from prior audits._

_Appended 2026-05-19: three **post-audit prod-observation** findings (S2-13, S2-14, S3-6) were added to the severity sections below and shipped — see `[FIXED 2026-05-19 — prod observation]` tags. These were not in the original 2026-05-18 sweep; they surfaced from watching the deployed game._

## Severity scheme

| Sev    | Meaning                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| **S1** | Correctness / integrity / cheat-vector in a core flow. Game still runs but produces wrong or exploitable results. |
| **S2** | Spec deviation. Game progresses, but behaviour disagrees with `SPEC.md`/`CLAUDE.md`.                              |
| **S3** | Robustness / polish / minor deviation. Low player impact.                                                         |

## Scope note — cheating deferred

Anti-cheat / adversarial-client hardening is **out of scope for now** (trusted-client, play-with-friends MVP). Findings whose only impact is "a crafted client could cheat" are kept on record below but tagged **`[DEFERRED — cheating out of scope]`** and excluded from the active priority list. They become relevant if/when the game is opened to untrusted players. The genuine correctness / spec bugs that affect honest play are unaffected by this and remain the priority.

## TL;DR

The game is end-to-end playable and the E2E suite is green, but several findings are **latent** — they don't trip the happy-path seeded tests yet still violate the spec:

- **Scoring is wrong for the gambling mechanic** (winning gambler nets +0, spec says +1) — affects honest play.
- **Czar rotation is recomputed from a live filtered array every round** — directly contradicts a stated non-negotiable; diverges on any drop and on Rando games.
- **Round-timer void path leaks white cards** out of the game (deck starvation on long games).
- Paused games never resume; reconnect snapshots drop winner/phase/turn; in-process timers aren't restored after a restart.
- Several server-side gates the spec mandates are UI-only — but those are cheat-defense and **deferred** per the scope note above.

---

## S1 — Correctness / integrity

### S1-1 · Winning gambler loses their wagered point (scoring bug)

- **Where:** `src/lib/game-engine.ts:877-907` (`gamble`), `:670-683` (`countGambleTransfers`), `:404-441` (`pickWinner`), `:685-768` (`castVote`), `:770-847` (`eliminateSubmission`).
- **Spec:** `SPEC.md:607` — _"If any of the player's submissions wins: they keep their wagered point and gain 1 from winning (**net +1, same as normal**)."_
- **Bug:** `gamble()` decrements score by 1 immediately (`:893`). When that player wins, `countGambleTransfers` explicitly skips the winner's own gamble key (`:678 if (gamblerId === winnerPlayerId) continue`), so the winner's `gain = 1 + bonus` never includes a refund of the wagered point. Net for a winning gambler = `-1 (wager) + 1 (win) = 0`, not the spec's **+1**. The wagered point is silently destroyed on a win.
- **Impact:** Core scoring is wrong in every normal-mode game where anyone gambles and wins. Players are punished for gambling successfully.
- **Fix sketch:** On a win, refund the wager — e.g. give the winning gambler `gain = 2 + bonus` (1 win + 1 returned wager), or don't deduct at submit time and instead settle at round end.

### S1-2 · Czar rotation recomputed from a live array every round

- **Where:** `src/lib/game-engine.ts:127-139` (`startRound`).
- **Spec:** `SPEC.md:613-617` — _"The Czar rotation does **not** recompute from live arrays — it traverses this stable list… A player who drops stays in `czarOrder` but is marked skipped. When the rotation lands on a dropped player, the engine increments past them."_ Also a **CLAUDE.md non-negotiable**: _"Stable `czarOrder` — never recompute rotation from live arrays."_
- **Bug:** Each round builds `activeOrder = order.filter(active && !isRando)` then indexes `activeOrder[(offset + round - 1) % activeOrder.length]`. The modulus is taken over the _current_ filtered length, so:
  - **Any drop** shrinks `activeOrder` and reshuffles who is Czar for everyone from that round on (not "skip past the dropped entry, keep everyone else stable").
  - **Rando games:** `czarStartOffset` is `chooseFirstCzar(activePlayers.length)` where `activePlayers` _includes_ Rando (`:66, :88`), but it is applied modulo `activeOrder.length` which _excludes_ Rando — so even round 1's Czar can disagree with the seed-precomputed expectation.
- **Impact:** Unfair/non-deterministic Czar assignment after drops; breaks the spec's stability guarantee and the seeded-determinism contract the E2E plan relies on (`SPEC.md:865, 878`). Currently latent because green tests don't drop a player mid-rotation or assert Czar in a Rando game.
- **Fix sketch:** Traverse the stable `czarOrder` with a persisted cursor; when the landed id is `dropped`, advance to the next non-dropped entry. Never `% activeOrder.length`.

### S1-3 · No Czar authorization on `pick` / `rank`

> **`[DEFERRED — cheating out of scope]`** Honest clients only `pick`/`rank` when the UI shows the Czar controls. Documented; not actioned now.

- **Where:** `src/ws/handler.ts:297-308`; `src/lib/game-engine.ts:404-441` (`pickWinner`), `:849-875` (`applyRanking` — `czarId` is received then discarded via `void czarId`).
- **Spec:** Normal mode: _"Czar picks"_; Serious Business: _"Czar ranks top 3"_ (`SPEC.md:673-675`, rules table).
- **Bug:** The handler passes `ctx.playerId` as the `czarId` argument but neither function verifies the caller actually _is_ the round's Czar (`roundRow.czarPlayerId`). Any non-spectator socket can send `{type:"pick"|"rank"}` and unilaterally resolve the round / award points.
- **Impact:** Trivial cheat: any player can declare a winner (themselves) or rank submissions.
- **Fix sketch:** In `pickWinner`/`applyRanking`, load the latest round row and reject if `caller !== roundRow.czarPlayerId`. Add a phase gate (`judging`/`ranking`).

### S1-4 · `submitCards` doesn't validate the cards belong to the player (or the pick count)

> **`[DEFERRED — cheating out of scope]`** The pick-count / hand-membership checks are adversarial-client defense; an honest UI always submits held cards in the right count. Documented; not actioned now.

- **Where:** `src/lib/game-engine.ts:350-379` (`submitCards`).
- **Spec:** Players submit from their dealt hand; black card's `pick` (1–3) is the required count (`SPEC.md:592`).
- **Bug:** `fills` are hydrated from _any_ valid `whiteCards` row id; there is no check that each id is in the player's Redis hand (`state.getHand`), and no check that `cardIds.length === black.pick`. `removeFromHand` simply no-ops for ids the player doesn't hold. There is also no `picking`-phase gate.
- **Impact:** A crafted client can submit arbitrary "best" cards it never held, or the wrong number of cards, or submit after `picking`.
- **Fix sketch:** Verify every `cardId` ∈ current hand; verify `cardIds.length === black.pick`; gate to `phase === 'picking'`.

---

## S2 — Spec deviations

### S2-1 · Round-timer void path leaks white cards and skips the black discard

- **Where:** `src/lib/game-engine.ts:222-231` (`expireRoundTimer`, the `< 2` branch).
- **Spec:** Round voided ⇒ submitted cards returned to hands, black card discarded, same Czar runs a fresh black card (`SPEC.md:573` and round-timer-expiry rules in `CLAUDE.md`).
- **Bug:** The timer-void branch only does `clearSubmissions` + `clearSkippedPlayers` + `startRound(round+1, czarId)`. It does **not** return submitted white cards to hands (they were `srem`'d in `submitCards`) nor discard the black card. Compare `voidRound()` (`:575-614`) which does both correctly.
- **Impact:** Every timer-voided round permanently shrinks the white deck / a player's hand. Over a long game this starves hands.
- **Fix sketch:** Reuse `voidRound`'s card-return + black-discard logic in the timer path (or call `voidRound`).

### S2-2 · No server enforcement of mode-specific resolution actions

> **`[DEFERRED — cheating out of scope]`** Only a crafted client sends a wrong-mode action; honest UIs render only the active mode's controls. Documented; not actioned now.

- **Where:** `src/ws/handler.ts:297-308`; engine `pickWinner`/`castVote`/`eliminateSubmission`/`applyRanking`.
- **Spec:** `SPEC.md:673-675` — God Is Dead has no Czar/voting only; Survival uses eliminations; Serious Business uses ranking; normal uses Czar pick.
- **Bug:** None of these check `config.rules`. In a `godmode` game a client can send `pick` and resolve the round directly, bypassing the vote; `vote` works in a normal game; etc.
- **Impact:** House-rule integrity bypass.
- **Fix sketch:** Gate each resolver on the active modal rule.

### S2-3 · `gamble` not gated to round ≥ 2 / normal mode

> **`[DEFERRED — cheating out of scope]`** The create-screen / session UI hides the gamble action in round 1 and in modal-rule games; only a crafted client bypasses it. Documented; not actioned now.

- **Where:** `src/lib/game-engine.ts:877-879` (only checks `score < 1 || hasGambled`).
- **Spec:** `SPEC.md:603, 609` — gambling is _"Available only in normal mode rounds from round 2 onward — disabled in any modal house-rule game… and on round 1."_
- **Bug:** No round check, no modal-rule check.
- **Impact:** Players can gamble in round 1 or in God Is Dead / Survival / Serious Business games, where the point math is undefined/broken.
- **Fix sketch:** Reject if `currentRound < 2` or any modal rule is active.

### S2-4 · `redraw` / `confess_discard` lack phase + rule-enabled gates

> **`[DEFERRED — cheating out of scope]`** The UI only surfaces these actions when the rule is enabled and the phase allows it; bypassing requires a crafted client. Documented; not actioned now.

- **Where:** `src/lib/game-engine.ts:909-922` (`redraw`), `:924-944` (`confessDiscard`); handler `:309-313`.
- **Spec:** Rebooting allowed only in `picking` + `transition`; Never Have I Ever only in `picking` + `transition` and capped at 3/game (`SPEC.md` house-rules table; `CLAUDE.md` rules table).
- **Bug:** `redraw` checks only `score >= 1`; `confessDiscard` checks only `discardsUsed < 3`. Neither checks the phase, nor that the corresponding rule (`rebooting` / `never_have_i_ever`) is in `config.rules`. A game without the rule still accepts the action and burns a point/discard.
- **Impact:** Players use rule mechanics in games that didn't enable them, at any phase.
- **Fix sketch:** Verify the rule is in `config.rules` and `phase ∈ {picking, transition}`.

### S2-5 · WS `leave` is under-implemented

- **Where:** `src/ws/handler.ts:318-326`.
- **Spec:** `SPEC.md:81` — _"Server removes player from Redis on `leave` message"_; explicit leave is meant to be immediate (vs. 30s grace for disconnects).
- **Bug:** `leave` only sets `status:'dropped'`, publishes `player_left`, fires analytics. It does **not**: remove the peer from `roomPeers`, trigger `voidRound`/`migrateHost`/`pauseGame`, or take effect immediately. If the client also closes the socket, the `close` handler unconditionally re-sets the player to `'grace'` (`:340`), so cleanup is delayed a full grace window and `player_left` is emitted twice. If the client keeps the socket open after `leave`, no cleanup ever runs.
- **Impact:** Czar/host leaving via the Leave button doesn't promptly void/migrate; duplicate `player_left`; possible stuck round.
- **Fix sketch:** On `leave`, run the same drop+void/migrate/pause path the grace timeout uses, immediately; remove the peer; make `close` a no-op if already dropped.

### S2-6 · `POST /api/games/$code/leave` is a stub

- **Where:** `src/routes/api/games/$code/leave.ts:11-12`.
- **Spec:** `SPEC.md:111` — _"Explicit leave outside WS. Removes player from game."_
- **Bug:** Authenticates then returns `204` with comment _"Phase 9 wires this…"_. No-op.
- **Impact:** `sendBeacon`/HTTP leave on unload does nothing server-side; cleanup depends entirely on the WS path.
- **Fix sketch:** Remove the player from Redis + publish `player_left` (+ void/migrate as in S2-5).

### S2-7 · No `conflicting_rules` validation server-side

- **Where:** `src/lib/api-helpers.ts:24-41` (`GameConfigSchema`); create (`src/routes/api/games/index.ts`) and start (`src/routes/api/games/$code/start.ts`) handlers.
- **Spec:** Modal rules (`godmode`/`survival`/`serious_business`) are mutually exclusive; `conflicting_rules` is a defined `ErrorCode` (`src/lib/types.ts:126`).
- **Bug:** Enforced only by the create-screen radio group. The schema accepts any subset of rules; no handler rejects >1 modal rule. `conflicting_rules` is never emitted anywhere.
- **Impact:** A non-UI client can create a game with two modal rules → undefined engine behaviour.
- **Fix sketch:** Add a `.refine` to `GameConfigSchema` rejecting >1 modal rule with `conflicting_rules`.

### S2-8 · Paused game never resumes; new joiners stay `queued` forever

- **Where:** `src/lib/game-engine.ts:653-660` (`pauseGame`); `src/routes/api/games/$code/join.ts:70-75`.
- **Spec:** Pause is for "all players dropped"; the sweeper abandons after 6h. Mid-game join is supported (`SPEC.md` mid-game join / `round_end` activation).
- **Bug:** When all humans drop, `pauseGame` sets `paused`. A subsequent joiner is inserted as `queued` (join.ts treats `paused` like `active`), but nothing flips `paused → active` or re-arms a round. `endRound`'s queued→active activation only runs if a round completes — which can't happen with no active players. The joiner is stranded until the 6h sweeper abandons the room.
- **Impact:** A paused room is effectively dead even though a player rejoined.
- **Fix sketch:** On join to a `paused` session with ≥ enough players, resume: set `active`, re-arm the current/next round.

### S2-9 · `buildSnapshot` loses winner, exact phase, and Survival turn on reconnect

- **Where:** `src/ws/handler.ts:47-136` (`buildSnapshot`).
- **Spec:** `state_snapshot` on rejoin must let the client resume the live round (`SPEC.md` reconnect).
- **Bug:** `winnerId` is hard-coded `null` (`:133`); `phase` is a heuristic from submission counts (cannot represent `reveal`/`transition`, and a reconnecting Czar can't tell `judging` from `picking` precisely); `eliminationTurnPlayerId` (Survival) and `ranking` (Serious Business) are not restored, although `voteTally` (God Is Dead) and `revealIndex` are. The authoritative `phase` is persisted (`state.setPhase`) but `buildSnapshot` re-derives instead of reading it.
- **Impact:** Reconnecting during reveal/judging/elimination shows a degraded/incorrect state; a winner shown just before `round_end` is lost on refresh.
- **Fix sketch:** Read persisted `phase`; include `winnerId`, `eliminationTurnPlayerId`, `ranking` from round state.

### S2-10 · In-process timers are not restored after a restart

- **Where:** `src/lib/game-engine.ts:184` (`setTimeout(... expireRoundTimer ...)`); reveal stagger `:316` (`sleep`).
- **Spec:** _"Server-controlled phase timing — clients never run their own phase timers"_ (CLAUDE.md non-negotiable).
- **Bug:** The round timer is a process-local `setTimeout`. `roundTimerExpiresAt` is persisted to Redis but nothing re-arms timers on boot. A server restart mid-round leaves the round with no timer; if a player never submits, the round hangs indefinitely. Same single-process assumption for the reveal loop.
- **Impact:** A deploy/restart mid-round can permanently stall that room.
- **Fix sketch:** On boot, scan active sessions and re-arm timers from `roundTimerExpiresAt` (or run a periodic reaper that fires expired round timers).

### S2-11 · `updatePlayer` is a non-atomic read-modify-write

- **Where:** `src/lib/game-state.ts:34-43`.
- **Bug:** `getPlayer` → spread patch → `hset` of the whole JSON. Concurrent callers (e.g. the grace-timeout drop in `handler.ts:343` racing an engine `score`/`hasGambled` update, or `endRound` clearing `hasGambled` for many players while another flow mutates the same player) can lose writes (last-writer-wins on the full object).
- **Impact:** Occasional lost score/status updates under concurrency.
- **Fix sketch:** Use per-field `HSET` on a per-player hash, or a Lua/`WATCH` CAS, instead of whole-object rewrite.

### S2-12 · Round outcomes are never persisted to `game_rounds` — `[FIXED 2026-05-19]`

- **Where:** `src/lib/game-engine.ts:166-174` (the only `INSERT`, at round _start_); `src/lib/game-state.ts:224-227` (`setRoundWinner` — Redis only); `src/routes/api/stats.ts:29` (unfiltered `count()`).
- **Spec:** The `game_rounds` schema (`SPEC.md` / `CLAUDE.md` DB schema) defines `winner_player_id`, `winning_submission_fills`, `ranking` (Serious Business), `vote_tally` (God Is Dead) — these are intended to be written on round resolution. `/api/stats` "Rounds judged" is meant to count judged rounds.
- **Bug:** The sole `game_rounds` insert fires at `round_started` with only structural fields (`sessionId, roundNum, blackCardId, czarPlayerId`). There was **no `UPDATE game_rounds` anywhere** — `setRoundWinner` and the ranking/vote-tally setters write Redis only. So all four result columns stayed permanently NULL; a row meant merely "a round was started" in _any_ session (lobby/abandoned/voided/in-progress/ended). `stats.ts` then did `count(*)` over the whole table with no `status='ended'` join and no winner filter, while every other aggregate in that endpoint scopes to ended sessions. Live prod showed **`rounds: 708` against only 2 ended games**, and **`topCards: []`** (its query needs `winning_submission_fills IS NOT NULL`, a column that was never written).
- **Impact:** Public `/stats` over-reports "Rounds judged" by ~2 orders of magnitude and shows an empty "Top cards" forever. No gameplay impact; the DB's analytical columns were dead.
- **Fix:** New `persistRoundOutcome` helper in `game-engine.ts`, called at all four judged-resolution funnels (normal / God Is Dead / Survival / Serious Business) just before `endRound`. Voided rounds bypass `endRound`, so they correctly stay unjudged. Serious Business derives `winner_player_id` from the top-ranked submission per spec; God Is Dead also persists `vote_tally`; Serious Business persists `ranking`. `stats.ts` "Rounds judged" now `innerJoin`s ended sessions + `isNotNull(winnerPlayerId)`. Regression test added in `tests/e2e/stats-screen.spec.ts` (TDD red→green). **Coverage gap:** the suite has no protocol driver for Survival / Serious Business, so those two persist sites are typecheck-verified only, not E2E-driven (pre-existing harness gap).

### S2-13 · Round result flashed past — winner / winning card never seen — `[FIXED 2026-05-19 — prod observation]`

- **Where:** `src/routes/games/$code/session.tsx` (old client `round_won` handler scheduled `setPhase('transition')` on a `WINNER_PAUSE` `setTimeout`); `src/lib/game-engine.ts` `endRound` (emitted the next `round_started` with no hold).
- **Spec:** `SPEC.md` E2E loop step 8 — a hold after a round resolves, winner highlighted, before the next round. **CLAUDE.md non-negotiable:** _"Server-controlled phase timing — clients never run their own phase timers."_
- **Bug:** The post-round pause was a **client** `setTimeout`. `endRound` published `round_won` → `round_end` → the next `round_started` back-to-back, so `round_started` wiped the board (cleared `submissions`/`winnerId`) before the client's timer fired. In prod the winner and winning card(s) were never visible — the round appeared to jump straight to the next one the instant the Czar picked.
- **Impact:** Every round in every mode: players never saw who won or the winning card(s). High-visibility UX defect.
- **Fix:** New `ROUND_RESULT_PAUSE_MS` (4000ms; `src/lib/timing.ts`) — the engine `await sleep()`s it in `endRound` between `round_end` and the next `round_started`, so the pause is **server-driven** (honours the non-negotiable). The client `WINNER_PAUSE` timer is removed; the board stays on the resolved round (phase `judging`, `winnerId` set) until the delayed `round_started`. `CAB_ROUND_RESULT_PAUSE_MS` env override shrinks it to 150ms for E2E. `tests/protocol.ts` (`playRound`/`playGodmode`) switched to `waitForNth` for round 2's `round_started` (the synchronous post-`round_end` read raced the new pause). Full E2E 46/46 green.

### S2-14 · Dropped players render as phantom 0-pt chips — scores appear to "reduce" — `[FIXED 2026-05-19 — prod observation]`

- **Where:** `src/lib/game-engine.ts` (four duplicated `players.map(...)` score builders in `pickWinner`/`endGame`/`castVote`/`eliminateSubmission`); `src/ws/handler.ts` `buildSnapshot`.
- **Spec:** The scoreboard reflects active participants; `PlayerScore[]` is the live tally.
- **Bug:** The score-payload builders included **every** player row, `status` regardless. `join.ts` always inserts a _new_ `game_players` row (new id, `score: 0`) on rejoin — it never reuses a dropped player's row — so a player who dropped and rejoined produced a stale 0-pt `dropped` chip _plus_ their fresh chip. To players this read as the scoreboard losing points / scores "weirdly reducing certain rounds" (the original prod report, observed in a plain game with no gambling/Rebooting/modal rule, ruling out the wager-transfer paths).
- **Impact:** Confusing, apparently-wrong scores in any game where someone dropped and rejoined. No actual score corruption — purely the displayed set.
- **Fix:** New `toPlayerScores(players, czarId)` helper (`game-engine.ts`) filters `status === 'dropped'` (keeps `grace`), used at all four engine funnels and `buildSnapshot` — one source of truth, no phantom chips. Unit tests added (`game-engine.test.ts`, TDD red→green).

---

## S3 — Robustness / polish

### S3-1 · Room-code casing is inconsistent across entry points

- **Where:** `join.ts:22` (`params.code.toUpperCase()`) vs. `start.ts:15-22` (raw `params.code`); WS `extractCode` regex only matches `[A-Z0-9]{6}` (`handler.ts:175`).
- **Impact:** A lowercase URL works for join (normalized) but mismatches start/WS. Codes are always generated uppercase so this is latent, but the handling is inconsistent.
- **Fix:** Normalize `code.toUpperCase()` once at every route boundary.

### S3-2 · Gamble point-transfer misses single-submission / no-submission gamblers

- **Where:** `src/lib/game-engine.ts:670-683` (`countGambleTransfers`), `:368` (storage-key logic).
- **Spec:** `SPEC.md:608` — _"If neither wins: the wagered point transfers to the round winner."_
- **Bug:** Transfer is counted only when a `:gamble` key exists _and_ the regular `submissions[gamblerId]` key also exists. A gambler who gambled then submitted only once (or not at all) has no `:gamble` key, so their lost wager is destroyed rather than transferred to the winner.
- **Fix:** Track gamble state from `hasGambled`, not from the presence of two submission keys.

### S3-3 · `czarOrder` not sorted by `joined_at` at game start

- **Where:** `src/lib/game-engine.ts:47-83` (`startGame` — DB select has no `orderBy`; Rando appended).
- **Spec:** `SPEC.md:613` — czarOrder is _"set at game start from active players sorted by `joined_at`"_.
- **Impact:** Rotation order depends on DB row order, not join order; minor fairness/determinism deviation (compounds S1-2).
- **Fix:** `orderBy(gamePlayers.joinedAt)` when building the initial order; exclude Rando from `czarOrder` (it never Czars).

### S3-4 · Late `play` can still mutate submissions after reveal starts

> **`[DEFERRED — cheating out of scope]`** Requires a client that sends `play` after it has left the picking screen. Documented; not actioned now.

- **Where:** `src/lib/game-engine.ts:350-379` (no phase gate); resolution is guarded by `setnx` (`:301`) but `setSubmission`/`removeFromHand` are not.
- **Impact:** A `play` arriving after the order is permuted can add/replace a submission that the reveal loop / resolver won't consistently account for.
- **Fix:** Same `picking`-phase gate as S1-4.

### S3-5 · Analytics payload deviations

- **Where:** `cab_game_created` (`index.ts:102-109`) omits the spec's `modalRule` property; `cab_gambled` (`game-engine.ts:901`) sends `{roomCode, playerId}` but spec lists `roomCode, round, playerId` (`SPEC.md:1092`).
- **Impact:** Minor analytics gaps only.
- **Fix:** Add the missing properties.

### S3-6 · Czar's own points hidden while judging — `[FIXED 2026-05-19 — prod observation]`

- **Where:** `src/components/game/Scoreboard.tsx`.
- **Spec:** The scoreboard shows every player's running score; the Czar is additionally flagged as judge.
- **Bug:** The score-chip meta line rendered the literal `JUDGE` for the current Czar _instead of_ their point total, so a player who became Czar saw their own score disappear for that round (replaced by the judge indicator).
- **Impact:** Minor but reported in prod — the Czar can't see their score while judging.
- **Fix:** Meta line now renders `JUDGE · N pts` for the Czar (`{isJudge ? \`JUDGE · ${pts}\` : pts}`), keeping both the indicator and the score. `czarId`remains the single authoritative judge source (the stale`PlayerScore.isJudge` is not OR'd in).

---

## Verification notes

- All file:line references verified against the working tree at audit time on `main` (HEAD `f84f9ee`).
- "Latent" findings (S1-2, S1-3, S1-4, several S2) do not currently fail the green E2E suite because the seeded happy-path scenarios don't exercise drops-mid-rotation, Rando-Czar assertions, crafted clients, or modal-mode action spoofing.
- `SPEC.md` remains canonical for intended behaviour; where this audit and the spec disagree, treat the spec as authoritative.

## Suggested priority order

_Cheat-defense findings (S1-3, S1-4, S2-2, S2-3, S2-4, S3-4) are deferred per the scope note and omitted here._

1. **S1-1** gambling refund — silent core-scoring corruption, hits every honest gambling game.
2. **S1-2 / S3-3** stable Czar rotation — restores the non-negotiable + seeded determinism.
3. **S2-1** timer-void card leak — deck starvation on long games.
4. **S2-8** paused game never resumes — strands rejoiners.
5. **S2-5 / S2-6** `leave` (WS + HTTP) — prompt host/Czar handoff, no duplicate `player_left`.
6. **S2-9 / S2-10 / S2-11** reconnect snapshot fidelity, timer restore on restart, atomic `updatePlayer`.
7. **S2-7** `conflicting_rules` validation (cheap server-side `.refine`).
8. S3 polish (S3-1 casing, S3-2 gamble-transfer edges, S3-5 analytics props).

> When anti-cheat comes back into scope, fold the deferred items in at roughly: S1-3 / S1-4 first (round resolution & submission integrity), then S2-2 / S2-3 / S2-4 / S3-4 (mode/phase/rule gates).
