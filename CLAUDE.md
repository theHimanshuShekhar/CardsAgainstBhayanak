# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> This document is a summary distilled from the canonical spec at `SPEC.md`. When this file and the spec disagree, **the spec wins.** When you need detail beyond what's here, read the spec section by section title.

---

## Project

A real-time multiplayer Cards Against Humanity clone, **Cards Against Bhayanak**. Jackbox-style: no accounts, 6-char room codes. Rotating Czar reads a black prompt, others submit white cards, funniest wins an Awesome Point. First to N points wins. Implements all 8 official 2014 CAH rulebook house rules.

**Status:** pre-implementation. Spec is complete; no source code yet. The next step is the `writing-plans` skill to convert the spec into an execution plan.

## Reference materials

| Location                                                    | Use for                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `SPEC.md`                                                   | Authoritative spec — read before coding                        |
| `docs/design-reference/project/Cards Against Bhayanak.html` | HTML prototype entry point                                     |
| `docs/design-reference/project/{styles,scenes,stats}.css`   | Design token + component CSS to port to `src/styles.css`       |
| `docs/design-reference/project/screens.jsx`                 | React component logic to port                                  |
| `docs/design-reference/project/content.js`                  | Placeholder card content (replaced at runtime by REST AH seed) |
| `docs/design-reference/chats/chat1.md`                      | Original design conversation                                   |

**Do NOT implement** `tweaks-panel.jsx` or `app.jsx`'s `TweaksPanel` block — design-tool meta-UI, not part of the real app.

---

## Tech stack (locked)

- **Framework:** TanStack Start (React 19, SSR, file-based routing) on Vinxi/h3
- **Styling:** Tailwind v4 via `@theme` in `src/styles.css` — **no `tailwind.config.ts`**
- **DB:** PostgreSQL via Drizzle ORM, `cuid2` IDs, `pnpm db:push` (no migrations — MVP tradeoff)
- **Cache + pub/sub:** Redis (Valkey image, `valkey/valkey:8-alpine`, AOF + RDB persistence)
- **Real-time:** Native WebSocket via h3's `crossws` on the same port as HTTP
- **Tests:** Playwright E2E, multi-context, real DB + Redis (no mocks)
- **Logging:** `pino` → Axiom in prod, `pino-pretty` in dev
- **Analytics:** PostHog Cloud (product analytics + session replay + error tracking)
- **Deployment:** Docker Compose; user manages Cloudflare Tunnel externally (not in compose)
- **Card data:** seeded at server start from `https://restagainsthumanity.com/api/v2/`

Don't substitute equivalents (no Next.js, no TanStack Query unless the spec calls for it). Ask before stack changes.

---

## Routes

| Path                   | Screen                              |
| ---------------------- | ----------------------------------- |
| `/`                    | Home                                |
| `/stats`               | Public stats                        |
| `/games/create`        | Create game                         |
| `/games/join`          | Join game                           |
| `/games/$code/lobby`   | Lobby (pre-game + mid-game waiting) |
| `/games/$code/session` | Game session                        |
| `/games/$code/end`     | End screen                          |

**API routes** under `src/routes/api/`:

- `GET /healthz` → `{ db, redis, activeGames, uptime }` or 503
- `GET /api/packs` → list packs (5 min cache)
- `GET /api/stats` → aggregated stats (5 min cache)
- `GET /api/config` → `{ posthogKey, posthogHost }` (delivered at runtime — never bundled into client)
- `POST /api/games` → `{ roomCode, playerId, sessionToken }`
- `POST /api/games/$code/join` → `{ playerId, sessionToken, status, gameStatus }`
- `POST /api/games/$code/start` → 204 (host-only)
- `POST /api/games/$code/leave` → 204
- `WS /api/games/$code/ws`

---

## Auth & session lifecycle

**Session-only, Jackbox-style.** No accounts, no passwords.

### Join flow

1. Client `POST /api/games/$code/join` with `{ username, anonId, role }` → server returns `{ playerId, sessionToken, status, gameStatus }`
2. Client writes `localStorage.cab_session = { roomCode, playerId, sessionToken, username, role, anonId }`
3. WebSocket connects, first message `{ type: "auth", sessionToken }`
4. Server validates HMAC, binds socket to playerId. All subsequent WS messages are scoped to that player (no IDs in payloads).

`sessionToken` = HMAC-signed `{ playerId, roomCode, issuedAt }`, valid until room's 24h Redis TTL expires.

### Reconnect

1. On page mount, if `cab_session` exists and URL mismatches, **always navigate to `/games/$code/lobby`**. Lobby route inspects `SessionStatus` from snapshot and redirects to `/session` or `/end` as needed.
2. Client sends `auth` then `rejoin`. Server replies with `state_snapshot`.
3. If grace expired → `auth_error` code `player_dropped` → client clears localStorage, redirects to `/`.

### `cab_session` clearing

Cleared on: explicit Leave button, "Go home" from end screen, or `auth_error`. **Persists through `game_over` and end screen** so "Play again" can reuse the handle.

### Disconnect timeline

- Clean disconnect (WS close) → 30s grace window → drop
- Half-open (45s no ping) → server force-closes WS → 30s grace → drop
- Total tolerance: 30s clean, up to 75s half-open

---

## Type definitions (essential subset)

All types in `src/lib/types.ts`. Used by both client and server.

```ts
type Role = 'player' | 'spectator'

type PlayerStatus = 'active' | 'queued' | 'spectator' | 'grace' | 'dropped'

type SessionStatus = 'lobby' | 'active' | 'paused' | 'ended' | 'abandoned'

type GamePhase =
  | 'picking'
  | 'waiting'
  | 'judging'
  | 'eliminating' // Survival of the Fittest
  | 'ranking' // Serious Business
  | 'reveal'
  | 'transition'

type ModalRuleId = 'godmode' | 'survival' | 'serious_business' // ≤ 1 active
type OrthogonalRuleId =
  | 'rebooting'
  | 'packing_heat'
  | 'rando'
  | 'never_have_i_ever'
  | 'happy_ending'
type RuleId = ModalRuleId | OrthogonalRuleId

type GameOverMode = 'normal' | 'happy_ending' | 'rando_won' | 'deck_exhausted' | 'abandoned'

type ErrorCode =
  | 'not_authorized'
  | 'invalid_token'
  | 'player_dropped'
  | 'spectator_action'
  | 'invalid_state'
  | 'rate_limited'
  | 'room_full'
  | 'room_not_found'
  | 'duplicate_username'
  | 'conflicting_rules'
  | 'host_only'
  | 'score_too_low'
  | 'internal_error'

type Card = { id: string; text: string } // black: blanks = "__________"
type BlackCard = Card & { pick: 1 | 2 | 3 }
type Hand = Card[] // 10 cards (11 with Packing Heat on pick:2)

type Submission = {
  submissionId: string // server opaque; mapping → playerId hidden until reveal
  fills: Card[] // order = submitter's order
  playerId?: string // only post-reveal
  rank?: 1 | 2 | 3 // Serious Business only
  eliminated?: boolean // Survival only
}

type GameConfig = {
  maxPlayers: number // 3–10
  roundsToWin: number // 3–20
  timer: '30s' | '60s' | '90s' | 'Off'
  packs: string[]
  rules: RuleId[]
}

type CabSession = {
  roomCode: string
  playerId: string
  sessionToken: string
  username: string
  role: Role
  anonId: string
}
```

See spec § Type Definitions for `SessionState`, `GamePlayer`, `PlayerScore`, `GameDraft`.

---

## WebSocket protocol

### Client → Server

```
{ type: "auth",            sessionToken }    // always first
{ type: "rejoin" }
{ type: "play",            cardIds[] }
{ type: "gamble" }                           // base mechanic (disabled in modal rules + round 1)
{ type: "pick",            submissionId }    // czar normal mode
{ type: "rank",            ranking[] }       // czar Serious Business
{ type: "vote",            submissionId }    // God Is Dead
{ type: "eliminate",       submissionId }    // Survival
{ type: "redraw" }                           // Rebooting the Universe
{ type: "confess_discard", cardId }          // Never Have I Ever
{ type: "leave" }
{ type: "ping" }                             // every 15s; 45s silence → grace
```

### Server → Client

```
auth_ok | auth_error(code, message)
state_snapshot(state)                         // on rejoin
player_joined(player) | player_left(playerId)
game_started(firstRound)
round_started(round, prompt, czarId|null, hand?)
player_played(playerId) | player_gambled(playerId) | player_skipped(playerId, round)
reveal_start | card_revealed(submissionIndex, fills)
round_won(winnerId, submissionId, scores)            // normal + God Is Dead
round_ranked(ranking, scoresDelta)                   // Serious Business
elimination_turn(playerId) | card_eliminated(submissionId, byPlayerId)  // Survival
vote_tally(votes)                                    // God Is Dead live
round_end(activatedPlayers, handsRefilled)           // every mode ends with this
game_over(finalScores, winnerId, mode: GameOverMode)
error(code, message) | pong
```

**`round_end` is the single source of truth for round termination across all modes** — always carries `handsRefilled`. Mode-specific outcome events (`round_won` / `round_ranked`) precede it.

---

## Game rules engine

### Core loop

1. Deal 10 white cards per active player at game start.
2. Each round: rotate Czar, deal black card from shuffled deck.
3. Non-Czar players submit `pick` white cards. **Order within a player's submission is preserved**; order between players is server-shuffled.
4. Resolve per mode (normal → Czar picks; God Is Dead → vote; Survival → eliminations; Serious Business → top-3 ranking).
5. Server emits `round_end` with `handsRefilled` (everyone tops back to 10). All submitted cards → `discard:white`. Black card → `discard:black` (no reshuffle).
6. First to `roundsToWin` wins → `game_over`.

### Czar selection

A stable `czarOrder` (list of playerIds) is established at game start in Redis. **Round 1 Czar = random index into czarOrder** (sets the offset). Round N = `czarOrder[(round1Idx + N - 1) % len]`. Dropped players stay in the list, marked skipped. Mid-game joiners appended at activation.

### Gambling (base mechanic; disabled in modal house-rule games and round 1)

Wager 1 Awesome Point before submitting → play a second submission. If either wins → keep the point. If neither wins → wagered point transfers to the round winner.

### Deck exhaustion

- White deck `< activePlayers * 3` → shuffle `discard:white` back in
- Black deck empty → `game_over` with mode `deck_exhausted`, current leader wins

### Round timer expiry

Player skipped for that round (empty submission). Server emits `player_skipped`. If <2 submitters total, void the round; same Czar runs a fresh black card.

### House rules (all official 2014 CAH)

| Rule                    | ID                  | Notes                                                                                |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------ |
| Rebooting the Universe  | `rebooting`         | Spend 1pt to redraw; allowed only during `picking` + `transition`                    |
| Packing Heat            | `packing_heat`      | Pick-2 black → +1 white card pre-submission                                          |
| Rando Cardrissian       | `rando`             | Synthetic player (DB row with `is_rando=true`) auto-submits each round               |
| God Is Dead             | `godmode`           | All players vote; tie re-vote ×2 then random; disables Gambling                      |
| Survival of the Fittest | `survival`          | Players take turns eliminating one card until one remains                            |
| Serious Business        | `serious_business`  | Czar ranks top 3 (3/2/1 points); `winner_player_id` = top-ranked                     |
| Never Have I Ever       | `never_have_i_ever` | Discard with confession; max 3 per player per game; only in `picking` + `transition` |
| Happy Ending            | `happy_ending`      | Host ends early via topbar ⋯ menu; forced "Make a Haiku" final round                 |

Modal rules (`godmode`, `survival`, `serious_business`) are mutually exclusive — UI enforces with radio group. Orthogonal rules stack freely.

---

## Database schema (Drizzle, Postgres)

```
packs          — id (cuid2), name, slug (unique), card_count, created_at
black_cards    — id, pack_id (fk), text, pick CHECK IN (1,2,3); unique(pack_id, text, pick)
white_cards    — id, pack_id (fk), text; unique(pack_id, text)

game_sessions  — id (cuid2), code (CHAR(6) unique, raw no-dash), status, config JSONB,
                 host_player_id (nullable FK), created_at, last_activity_at, ended_at,
                 winner_player_id (nullable FK), end_mode (nullable enum, = GameOverMode)
                 status: lobby | active | paused | ended | abandoned

game_players   — id (cuid2), session_id (fk), username, role, score, status,
                 is_host, is_rando, discards_used INT DEFAULT 0,
                 posthog_anon_id (nullable text), joined_at
                 status: active | queued | spectator | grace | dropped
                 unique(session_id, username); partial unique(session_id) WHERE is_rando

game_rounds    — id, session_id (fk), round_num, black_card_id,
                 czar_player_id (nullable for God Is Dead),
                 winner_player_id (nullable; for Serious Business = top-ranked),
                 winning_submission_fills JSONB,
                 ranking JSONB (Serious Business only),
                 vote_tally JSONB (God Is Dead only),
                 played_at; unique(session_id, round_num)

INDEX idx_sessions_last_activity ON game_sessions (last_activity_at) WHERE status IN ('active', 'paused')
INDEX gin_winning_fills ON game_rounds USING gin (winning_submission_fills)
```

### Host FK chicken-and-egg

`host_player_id` is nullable. Flow: insert session (NULL host) → insert host player → UPDATE session set host_player_id.

### Stale-game sweeper

Background job via `node-cron` (`*/30 * * * *`, started at process boot). Marks `active|paused` sessions with `last_activity_at < now() - 6h` and zero Redis players as `abandoned`.

---

## Redis state shape (per room)

```
game:{code}                hash: status, currentRound, czarIndex, hostId, config, lastActivityAt
game:{code}:players        hash: playerId → GamePlayer JSON
game:{code}:czarOrder      list of playerIds (stable rotation order)
game:{code}:round          hash with mode-aware fields:
                             blackCardId, czarId, submissions, winnerId,
                             ranking (Serious Business),
                             voteTally (God Is Dead),
                             eliminationTurnPlayerId + eliminations (Survival),
                             roundTimerExpiresAt
game:{code}:deck:black     list (shuffled)
game:{code}:deck:white     list (shuffled)
game:{code}:discard:white  list (reshuffled into deck when low)
game:{code}:discard:black  list (informational; no reshuffle)
game:{code}:hand:{id}      set of white card IDs
game:{code}:grace:{id}     string with PX expiry = GRACE_WINDOW_MS
game:{code}:channel        pub/sub channel
```

All keys: 24h TTL on idle, refreshed on mutation. Submissions write via single `HSET` op → atomic.

---

## Visual design system

**Strict monochrome B&W. No colour accents.** Tokens live in `src/styles.css` (Tailwind v4 `@theme` block).

- **Fonts:** Geist (body), Bricolage Grotesque (display), Geist Mono (codes/labels)
- **Card sizes (5:7 ratio):** `.card-sm` 140px / `.card-md` 200px / `.card-lg` 280px / `.card-xl` 360px
- **Semantic class names**, not Tailwind utility soup: `.btn`, `.card-prompt`, `.scoreboard`, `.hand-dock`, `.sheet`, `.stepper`, `.seg`, `.check-card`
- **Hand dock:** 10 cards fanned per official CAH rules
- **Mobile breakpoints:** 1100px, 860px, 720px, 420px (verbatim from design reference)
- **Prompt blanks:** `__________` (10 underscores) → rendered as `<u>` styled per design
- **Animation timing constants** in `src/lib/timing.ts`: `DEAL_MS=550`, `FADE_IN_MS=400`, `REVEAL_STAGGER=700`, `WINNER_PAUSE=2600`, `RECONNECT_TOAST=250`, `GRACE_WINDOW_MS=30000`

---

## Card seeding (REST Against Humanity)

`src/lib/seed.ts` runs at server boot (async, doesn't block). Steps:

1. `GET https://restagainsthumanity.com/api/v2/packs` → pack names
2. For each pack: `GET /cards?packs=<name>` → black + white cards
3. Normalise black card text: replace `_` with `__________`
4. Upsert: `ON CONFLICT DO NOTHING` on `packs.slug`, `(pack_id, text, pick)` for black, `(pack_id, text)` for white
5. Retry with exponential backoff (1s/2s/4s/max 30s); fall back to cached DB data if API down

Gameplay routes return 503 if DB has zero packs.

---

## PostHog (Cloud, `app.posthog.com`)

Product analytics + session replay + error tracking. SDKs: `posthog-js` (client) + `posthog-node` (server).

- **Distinct ID** = `anonId`, stable browser UUID in `localStorage.cab_anon_id`. Sent in HTTP join/create bodies; persisted on `game_players.posthog_anon_id`. Server uses same ID for server-side events.
- **Key delivery:** server reads `POSTHOG_API_KEY` env → exposed to client via `GET /api/config`. **Not bundled into Vite build.** Rotation = env update + restart, no rebuild.
- **Session replay masking:** all `.card-text` and `.card-back-mark` elements carry `data-ph-no-capture`. CAH content is crude — never recorded.
- **Autocapture: off.** All events explicit. `$pageview` auto-captured for route visits.
- **Event taxonomy:** every event prefixed `cab_*`. See spec § Event taxonomy for the full list (~25 events covering onboarding, lobby, gameplay, connection lifecycle, end-of-game).
- **Error tracking:** React error boundary + global `unhandledrejection` (client); h3 error middleware + WS handler try/catch (server).

---

## Randomness

All non-cryptographic randomness routes through `src/lib/rng.ts` (wraps `seedrandom`):

```ts
randomInt(min, max) // inclusive min, exclusive max
shuffle<T>(array) // Fisher-Yates, returns new array
pick<T>(array) // single random element
```

- Production: seeded at boot from `crypto.randomBytes(16)` (non-deterministic)
- Tests: `CAB_RNG_SEED=test-seed-2026` → fully reproducible games (first Czar, decks, Rando's picks)
- **Crypto-strength randomness (room codes, HMAC nonces) uses `crypto` directly** — never this wrapper

Room code generation: `crypto.randomInt(0, 31)` per char, alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no O/0/I/1/L). 6 chars stored raw, displayed as `XXX-XXX`.

---

## Environment variables

| Var                                | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`                     | Postgres                                         |
| `REDIS_URL`                        | Redis/Valkey                                     |
| `SESSION_SECRET`                   | HMAC secret for sessionToken                     |
| `PORT`                             | Default 3000                                     |
| `NODE_ENV`                         | `development` \| `production`                    |
| `AXIOM_TOKEN` + `AXIOM_DATASET`    | Log shipping (prod only)                         |
| `POSTHOG_API_KEY` + `POSTHOG_HOST` | Server reads; relays to client via `/api/config` |
| `POSTHOG_PERSONAL_API_KEY`         | Build-time sourcemap upload only                 |
| `CAB_RNG_SEED`                     | Tests only                                       |

---

## Project file structure (target — does not exist yet)

The spec § Project File Structure is authoritative. Key directories:

- `src/routes/` — file-based routes (`__root.tsx`, screens, `api/`)
- `src/components/{ui,game}/` — UI primitives + game-specific components
- `src/contexts/GameContext.tsx` — pre-game draft state
- `src/hooks/{useGameSocket,useSession}.ts`
- `src/lib/` — `timing.ts`, `rng.ts`, `game-engine.ts`, `game-state.ts`, `game-event-handler.ts`, `seed.ts`, `sweeper.ts`, `session-token.ts`, `code-gen.ts`, `rate-limit.ts`, `logger.ts`, `posthog-{client,server}.ts`, `types.ts`
- `src/ws/{handler,auth}.ts` — h3 WS handler
- `src/db/{schema,index}.ts` — Drizzle
- `src/styles.css` — single CSS file
- `tests/e2e/` — Playwright specs; `tests/fixtures/{handles,expected-outcomes}.ts`
- `Dockerfile`, `docker-compose.yml`, `docker-compose.prod.yml`

---

## Commands (target — will exist once `package.json` is created)

| Command                               | Purpose                                      |
| ------------------------------------- | -------------------------------------------- |
| `pnpm dev`                            | Dev server with HMR at http://localhost:3000 |
| `pnpm build`                          | Production build to `.output/`               |
| `pnpm db:push`                        | Apply Drizzle schema (dev or prod)           |
| `pnpm db:studio`                      | Drizzle Studio                               |
| `pnpm seed`                           | Trigger card pack seeding manually           |
| `pnpm typecheck`                      | TypeScript check                             |
| `pnpm lint`                           | ESLint                                       |
| `pnpm test:e2e`                       | Playwright (requires Postgres + Redis up)    |
| `pnpm test:e2e:ui`                    | Playwright UI mode                           |
| `docker compose up -d postgres redis` | Just deps for local dev                      |
| `docker compose up -d`                | Full stack                                   |

---

## Non-negotiable conventions

These are the things the spec was deliberate about — don't "improve" them without asking:

- **`pnpm db:push` in prod** (MVP tradeoff; review diff before confirming)
- **Token replay risk accepted** (24h HMAC, no rotation, no IP binding)
- **Modal rules mutually exclusive** in the UI (radio group, not checkboxes)
- **`round_end` is the uniform termination event** across all modes
- **Server-controlled phase timing** — clients never run their own phase timers
- **Submission privacy** — server hides `submissionId → playerId` until reveal
- **Stable `czarOrder`** — never recompute rotation from live arrays
- **PostHog key never in Vite build** — always runtime-relayed via `/api/config`
- **CAH card content masked from session replay** via `data-ph-no-capture`
- **`pnpm db:push` is no-migrations** — no `drizzle-kit generate` files in `migrations/`
- **Cloudflare Tunnel runs outside compose** — user manages it; don't add a `cloudflared` service

---

## Memory

Auto-memory lives in `/home/hshekhar/.claude/projects/-home-hshekhar-code-CardsAgainstBhayanak/memory/`. The existing `project_overview.md` predates the current spec and references files that don't exist yet. **Trust the spec over memory** if they disagree.
