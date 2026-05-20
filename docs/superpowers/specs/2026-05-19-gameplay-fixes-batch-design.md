# Gameplay Fixes Batch — Design

_Date: 2026-05-19 · Status: approved for implementation (Phase 1 detailed, Phase 2 outline)_

## Context

Nine issues were reported from watching the deployed game. They split into six
clear bugs and three feature/behaviour changes. Per the agreed delivery plan:

- **Phase 1** — the six bugs, shipped and reviewed first.
- **Phase 2** — the three features, designed in detail at Phase 2 kickoff after
  Phase 1 review.

`SPEC.md` remains canonical. One Phase 1 fix (#7) intentionally amends a
documented spec detail; that deviation is called out explicitly below and the
spec text is updated as part of the change.

Root causes below were traced to specific source lines on `main`.

---

## Phase 1 — Bugs

### #1 · Winner shows player ID instead of name

- **Where:** `src/components/game/SubmissionsGrid.tsx:78-84`.
- **Cause:** the winner badge renders the raw opaque `s.playerId`
  (`+1 clx2abc…`) and passes it to `<Avatar name=…>`.
- **Fix:** thread the existing `scores: PlayerScore[]` (already held in
  `session.tsx`) into `SubmissionsGrid`. Build a `playerId → username` lookup;
  render `+1 {username}` and feed the real username to `<Avatar>`.
- **Surface:** props only; no server or protocol change.
- **Verify:** in a finished round the winner badge reads the winner's handle;
  unknown/missing id degrades to a neutral placeholder, never a crash.
- **Deviation (as built):** the prescribed `playerId → username` lookup keyed
  on `s.playerId` is unworkable — the client never receives `s.playerId`
  (`card_revealed` omits it for submission privacy), so it is always
  `undefined` and the badge never rendered. As built: resolve the winner's
  handle in `session.tsx` from `round_won.winnerId` (a playerId) + the
  `scores` payload (and the equivalent from `state_snapshot.winnerId`), and
  thread it as a `winnerName` prop. Still props-only; no protocol change.
  Missing id → `"Winner"` placeholder. The grid still highlights the
  winning card by `submissionId`; only the badge text/avatar changed.

### #4 · Prompt text doesn't scale between phone and desktop

- **Where:** `src/styles.css` — `.card-xl .card-text` (~`:550-551`); first
  responsive step is `@media (max-width: 720px)` (~`:693-701`).
- **Cause:** the xl prompt text is a flat `30px` until 720px, so on
  tablet / narrow-desktop widths (≈720–1100px) the prompt overflows the card.
- **Fix:** CSS-only. Make the xl prompt text fluid via `clamp()` (preferred) or
  add intermediate steps at the existing 1100 / 860 / 720 breakpoints so the
  text shrinks proportionally and never overflows. Scoped to the prompt card;
  no other selector or any logic touched.
- **Verify:** at 1100 / 900 / 760 / 640 / 420px the longest seeded prompt fits
  inside `.card-xl` without clipping or scrollbars.

### #5 · Submission counter logic is wrong

- **Where:** `src/components/game/PromptStage.tsx:53-66`; placeholder tracking
  in `src/routes/games/$code/session.tsx:76-79`.
- **Cause:** the denominator is "submissions seen so far" (`present.length`),
  and the string is only ever `N of N` (waiting) or `0 of N` (picking). It can
  never express true progress like `2 of 4`.
- **Fix (server-authoritative — chosen):**
  - Server stamps `submitted` and `expected` onto the existing `player_played`
    event, and includes `expected` in `round_started` and `state_snapshot`.
  - `expected` = number of players required to submit this round
    (non-Czar active players; includes Rando, which auto-submits; in God Is
    Dead every player submits so `expected` = all active players).
  - `submitted` = distinct players whose submission the server has recorded
    so far (including Rando's auto-submit).
  - Client renders `{submitted} of {expected} submitted` with one pip per
    `expected` slot, filling as `submitted` grows. The local placeholder
    array is replaced by these authoritative counts.
- **Rejected alternative:** client-only derivation
  `expected = scores.filter(s => !s.isJudge).length`. Lighter but fragile
  around Rando's auto-submit, the Czar's own non-submitting "waiting" state,
  and mid-round drops. Server-truth removes the entire bug class.
- **Protocol delta:**
  - `player_played` gains `submitted: number`, `expected: number`.
  - `round_started` and `SessionState` gain `expected: number`.
  - Types updated in `src/lib/types.ts`; both producers and the client updated
    together.
- **Verify:** a 4-player normal game shows `0→1→2→3 of 3` (Czar excluded);
  a Rando game's auto-submit advances the count; a God Is Dead game shows
  `… of {all players}`.
- **Deviation (as built):** Rando is **excluded** from both `submitted` and
  `expected`, not included as the doc states. The counter must reach
  `N of N` exactly when the round resolves, and `checkRoundReady`'s
  resolution gate already excludes Rando (it auto-submits at round start and
  is not a gate member). Counting Rando would desync the displayed counter
  from the resolution predicate. `submissionProgress` deliberately mirrors
  `checkRoundReady`'s predicate verbatim (a code comment ties them together).
  `autoSubmitRando` still emits its `player_played` with the (Rando-excluded)
  counts so the client pip state stays consistent.
- **Root-cause fix surfaced during verification (not in original scope):**
  the Rando protocol E2E failed under full-suite load with `cardRevealed=6`
  (every published frame delivered 2–3×). Traced to a pre-existing
  concurrency race in `ensureSubscriber` (`src/ws/handler.ts`): the
  idempotency guard (`listenerCount > 0`) was checked, then `await
sub.subscribe(...)`, then the listener attached — so concurrently-
  connecting peers all slipped past a still-zero count and each attached a
  duplicate `message` listener on the shared per-channel subscriber. #5's
  added `submissionProgress` latency widened the window enough to expose it
  (passed in isolation, failed under load). Fix: attach the listener
  **before** awaiting `subscribe` so the guard check and the `sub.on` that
  satisfies it run with no `await` between them (atomic w.r.t. the event
  loop); racing callers now await `subscribe` for frame-safety and return
  without adding a listener. Full E2E green (46/46) after the fix.

### #6 · Multi-blank pick numbering scrambles

- **Where:** `src/routes/games/$code/session.tsx:134-144` (`handleToggle`).
- **Cause:** when `selected.length >= prompt.pick` and the player taps another
  unselected card, the full-hand branch does `[...prev.slice(1), cardId]` —
  it silently evicts pick #1 and renumbers every remaining card.
- **Fix:** when `selected.length >= prompt.pick`, **ignore taps on unselected
  cards** (the player must explicitly deselect one first). Deselect/reselect
  already renumbers correctly via `selected.indexOf(card.id)` in
  `HandDock.tsx`. This matches the design reference's "pick N in order" model.
- **Rejected alternative:** replace the last pick instead of ignoring —
  less predictable for the player.
- **Surface:** one function in `session.tsx`; `HandDock` already correct.
- **Verify:** for a pick-2 prompt, selecting A then B shows 1,2; tapping a
  third card C does nothing; deselecting A then tapping C shows B=1, C=2.

### #7 · Hand reshuffles every round _(intentional spec amendment)_

- **Where:** `src/lib/game-state.ts:130-146`
  (`setHand` / `getHand` / `removeFromHand`).
- **Cause:** the hand is stored as a Redis **set** (`sadd` + `smembers`).
  Sets have no defined order, so every refill and every `state_snapshot`
  returns the hand in arbitrary order — the player's cards appear shuffled on
  each round switch.
- **Fix:** store the hand as a Redis **list**:
  - `setHand` → `del` + `rpush` (preserve given order).
  - `getHand` → `lrange 0 -1`.
  - `removeFromHand` → `lrem` per card id (or rebuild list minus removed).
  - Refilled cards append to the tail; surviving cards keep their position,
    so hand order is stable across rounds.
- **Spec deviation (explicit):** `SPEC.md:826` and `CLAUDE.md:327` both state
  `game:{code}:hand:{id}  set of white card IDs`. A set cannot preserve order,
  which is the direct cause of this bug. This design **amends the spec**: the
  hand becomes an ordered list. Both `SPEC.md:826` and `CLAUDE.md:327` are
  updated to `list of white card IDs (ordered; refills append to tail)` as
  part of this change so the canonical spec and code stay in agreement.
- **Verify:** play ≥3 rounds; unplayed cards keep their relative order every
  round; newly dealt cards appear at the end of the hand, not interleaved.

### #9 · Final round skips the winner reveal

- **Where:** `src/lib/game-engine.ts:658-681` (`endRound`).
- **Cause:** the happy-ending branch (`:660-665`) and the score-threshold
  branch (`:667-671`) call `endGame()` → `game_over` **before** the
  `await sleep(roundResultPauseMs())` hold at `:678`. Every non-final round
  gets that paced reveal hold; the deciding round does not, so its
  `round_won` / card reveal never gets a display window — the client jumps
  straight to the end screen.
- **Fix:** hoist `await sleep(roundResultPauseMs())` to run immediately after
  `round_end` is published and **before** the game-over / next-round
  branching. Every round — including the last — then gets the identical paced
  reveal hold, after which the deciding round proceeds to `game_over` and the
  others to `startRound`. One-statement move; no new timing constant.
- **Verify:** the winning play of the final round is visibly highlighted for
  the same duration as every other round before the end screen appears;
  non-final rounds are unchanged; happy-ending and score-threshold paths both
  honour the hold.

---

## Phase 2 — Features (detailed; Phase 1 shipped & reviewed in `afefc89`)

Three features. #8 is a one-function change; #2 threads an existing
server timestamp to a display-only client countdown; #3 is the largest —
a server reset action plus an end-screen WS connection and an in-lobby
config editor. All scope-critical decisions were locked with the user:
**#3 = full in-lobby editing**, **#8 = dedupe black + white, normalized**.

### #8 · Duplicate prompts across packs

- **Where:** `buildDecks` — `src/lib/game-engine.ts:45-53`.
- **Cause:** the same prompt/answer text sourced from multiple RAH packs
  is stored as distinct `(pack_id, text)` rows; selecting by `packId`
  yields visibly duplicate cards in one game.
- **Fix (locked: black + white, normalized):** after fetching the
  `black` / `white` rows, dedupe **each** list by
  `key = text.trim().toLowerCase()`, keeping the first occurrence, then
  shuffle the surviving IDs as today. ~6 lines, one function.
- **Surface:** none. No protocol, schema, type, or client change.
- **Unchanged:** the spec's `deck_exhausted → game_over` (current leader
  wins) is untouched — a smaller deduped deck just reaches exhaustion
  sooner if a game runs that long.
- **Verify:** unit test on `buildDecks` output — no two black (and no two
  white) card texts collide case-insensitively after trim, for a
  multi-pack config that is known to contain cross-pack duplicates.

### #2 · Prominent stage timer

- **Server already has the truth.** `state.setRoundTimerExpiresAt` is
  stamped in `startRound` when `config.timer !== 'Off'`
  (`game-engine.ts:232-237`); `getRoundTimerExpiresAt` reads it back. The
  authoritative expiry/skip stays entirely server-side
  (`expireRoundTimer`) — **no client phase logic** (non-negotiable).
- **Protocol delta (display-only):**
  - `round_started` event gains `roundTimerExpiresAt: number | null`
    (epoch ms; `null` when `timer === 'Off'`). Published from `startRound`
    where the expiry is already computed.
  - `SessionState` gains `roundTimerExpiresAt: number | null`, populated
    in `buildSnapshot` from `getRoundTimerExpiresAt` (→ `null` if absent /
    timer Off) so a reconnecting client resumes a correct countdown.
  - Types updated in `src/lib/types.ts`; both producers + client together.
- **Client:** `session.tsx` tracks `roundTimerExpiresAt`, set from
  `round_started` and `state_snapshot`, cleared (`null`) on each new
  `round_started`. Passed to `PromptStage`, which renders a large
  countdown beside the prompt: a display-only `setInterval(…, 1000)`
  computing `remaining = max(0, expiresAt - Date.now())`, an urgency
  class under ~10 000 ms, the interval cleared on unmount / when
  `expiresAt` is `null`. When `null`, the timer is not rendered at all.
- **Why timestamp not seconds:** absolute server epoch survives a refresh
  and clock-skews gracefully; a "seconds left" countdown would drift and
  would be a client-run timer in disguise.
- **Verify:** protocol E2E asserts `round_started.roundTimerExpiresAt` is
  a future epoch for a `30s` game and `null` for an `Off` game; the
  snapshot carries it on rejoin. Component check for the countdown +
  urgency cue + hidden-when-null.

### #3 · Rematch + Back to lobby _(largest change)_

End screen gets two **host-only** actions; non-host players are carried
automatically over WS. Same room code throughout; players keep their
handles (`cab_session` already persists through `game_over` per spec).

**Server — `engine.resetGame(code, mode: 'rematch' | 'lobby')`:**

- Clears all per-round Redis state for the room: `round`, `deck:black`,
  `deck:white`, `discard:white`, `discard:black`, every `hand:{id}`,
  `czarOrder`, and the `game:{code}` round/phase fields
  (`currentRound`, `czarStartOffset`, timer). Reuses existing key
  constants; **room code and `game:{code}:players` survive**.
- Carried players: status `active` **or** `grace` → score `0`,
  status `active`, `discardsUsed 0`, gamble flag cleared (DB + Redis
  mirror). Status `dropped` players are **not** carried (default;
  flagged below).
- Deletes prior `is_rando` rows (partial-unique per session); `startGame`
  re-creates Rando if the rule is still configured.
- Clears `game_sessions.winner_player_id / ended_at / end_mode`.
- `mode: 'lobby'` → `status = 'lobby'`, broadcast `lobby_snapshot`.
- `mode: 'rematch'` → `status = 'active'`, then the existing
  `startGame` + `game_started` + `startRound` path (fresh decks,
  fresh `czarOrder`, scores already 0).

**New REST — `POST /api/games/$code/reset { mode }`:** host-only
(403 `host_only` otherwise); `session.status` must be `'ended'`
(409 `invalid_state` otherwise — this also guards a double-reset race);
calls `resetGame`; 204.

**New REST — `PATCH /api/games/$code/config { config }`:** host-only;
`session.status` must be `'lobby'` (409 otherwise); validates with the
**same** rules as create — reuse `CreateGameSchema`'s config shape
(`api-helpers.ts:25-29`) and the modal-exclusivity check
(`index.ts:52-65`), extracted to one shared helper so create and patch
cannot diverge; writes `game_sessions.config` (JSONB); broadcasts the
updated `lobby_snapshot`. 204.

**New WS event — `game_reset { mode }`:** broadcast by `resetGame` so
every connected client (including non-hosts) re-routes.

**End screen gains a WS connection.** Today `end.tsx` has none — it reads
`cab_last_game_over` from `sessionStorage`. It gains the standard
`useGameSocket` (`auth` → `rejoin`) purely as a redirect hub:

- `game_reset` (either mode) → navigate to `/games/$code/lobby`. The
  lobby is already the universal reconnect hub: on its `lobby_snapshot`
  it keeps players in `lobby`, and auto-forwards to `/session` once
  status is `active` (covers the rematch path with no extra logic).
- `lobby_snapshot` / `state_snapshot` arriving directly → same hub
  routing as lobby today.
- The end screen derives `isHost` from the rejoin/lobby snapshot's
  `players` (`GamePlayer.isHost`). Host sees **Rematch** + **Back to
  lobby** (POST `/reset`); non-host sees a disabled "Waiting for the
  host…" affordance. Existing **Play again** (→ `/games/create`, a
  brand-new room) and **Go home** stay.

**Lobby gains host config editing.** `lobby.tsx` currently renders
`config` read-only. When `isHost && status === 'lobby'`, the same config
controls used on the create screen become editable and persist via
`PATCH /config` (debounced or on-blur/explicit-apply — exact UX is a
small build-time call, not a design fork); non-hosts keep the read-only
view, refreshed by the broadcast `lobby_snapshot`. Modal-rule radio /
3–10 / 3–20 / timer-enum / ≥1-pack constraints are enforced server-side
by the shared validator regardless of client.

**Edge cases:** reset when not `ended` → 409; non-host reset/patch →
403; double reset guarded by the `status === 'ended'` precondition (first
wins, second 409); `czarOrder` and Rando are rebuilt fresh by `startGame`
on rematch; a player who dropped before reset is not carried (see
default below); clients still on `/session` when a reset happens receive
`game_reset` and route through the lobby hub.

**Decision (user-confirmed 2026-05-19) — dropped-player carry:** carry
`active` + `grace`, **exclude `dropped`** (a dropped player has no live
socket and cleared session; they re-join by code into the new lobby).

**Build order (user-chosen 2026-05-19):** #3 → #2 → #8. Full E2E suite
kept green after each.

**Protocol deltas (#3):** new `POST /api/games/$code/reset`; new
`PATCH /api/games/$code/config`; new WS `game_reset { mode }`; end
screen gains a WS connection (no new event types beyond `game_reset`).

---

## Out of scope

- Anti-cheat / adversarial-client hardening (per `AUDIT.md` deferral).
- Any change to modal-rule resolution, czar rotation, or the `round_end`
  termination contract beyond the #9 timing hoist.
- No new dependencies; tech stack unchanged.

## Testing

- Phase 1 ships with the existing Playwright E2E suite kept green
  (`pnpm test:e2e`, requires Postgres + Redis; DB password `testpassword123`,
  Redis db1, kill any stale `:3000`).
- Targeted E2E coverage added where a bug has an observable assertion:
  #5 counter text, #6 pick-order badges, #7 stable hand order across rounds,
  #9 final-round winner highlight before `game_over`.
- #1 and #4 verified by component/visual check; #4 has no logic to assert.
- Phase 2 keeps the full suite green and adds: #8 unit test on
  `buildDecks` (no case-insensitive text collisions); #2 protocol test
  (`round_started.roundTimerExpiresAt` future epoch for `30s`, `null`
  for `Off`; carried in snapshot on rejoin); #3 protocol test (play to
  `game_over` → host `reset rematch` → `round_started` round 1 with all
  scores 0; `reset lobby` → `lobby_snapshot` status `lobby` → `PATCH
/config` → start → new game; non-host reset → 403; reset when not
  `ended` → 409). #3 lobby editor + end-screen buttons get a
  component/visual check.
