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

## Phase 2 — Features (outline; detailed at Phase 2 kickoff)

Designed in full only after Phase 1 is shipped and reviewed.

### #2 · Prominent stage timer

Server already persists `roundTimerExpiresAt`. Add
`roundTimerExpiresAt: number | null` to `round_started` and `SessionState`
(and the snapshot). Client renders a large countdown beside the prompt,
derived purely from the server timestamp (display-only local interval — no
client-run phase logic, per the server-controlled-timing non-negotiable),
with an urgency cue under ~10s, hidden entirely when `config.timer === 'Off'`.

### #3 · Rematch + Back to lobby

End screen gets two host actions:

- **Rematch** — same room code, same config, scores → 0, straight into a new
  game.
- **Back to lobby** — same room code, everyone returns to the lobby, host
  reconfigures (packs / rules / points / timer), then Start.

Non-host players are moved via WS ("waiting for host…"). Requires a server
reset action that reuses the room code, rebuilds decks, resets scores, and
keeps players and their handles. Full design (endpoint/WS shape, state
transitions, edge cases) produced at Phase 2 start.

### #8 · Duplicate prompts across packs

`buildDecks` (`src/lib/game-engine.ts:45-50`) selects cards by `packId`; the
same prompt text sourced from multiple RAH packs yields duplicate-looking
prompts. Fix: dedupe the deck by card **text** when building it. The spec's
`deck_exhausted → game_over` behaviour is unchanged.

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
