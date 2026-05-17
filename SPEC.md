# Cards Against Bhayanak — Design Spec

_2026-05-12_

## Overview

A real-time multiplayer card game in the Cards Against Humanity genre. Players join via a 6-character room code (Jackbox-style — no accounts, no login). One rotating Card Czar reads a black prompt card; everyone else submits white response cards; the funniest answer wins an Awesome Point. First to N points wins.

---

## Tech Stack — ✅ DONE

- **Framework:** TanStack Start (React 19, SSR, file-based routing via `@tanstack/react-router`, Vinxi/h3 bundler)
- **Styling:** Tailwind CSS v4 — configured via `src/styles.css` (`@theme` block), no `tailwind.config.ts`
- **Database:** PostgreSQL via Drizzle ORM (`pnpm db:push`, no migrations)
- **Cache / pub-sub:** Redis (Valkey image in Docker)
- **Real-time:** Native WebSocket via Vinxi/h3 (`crossws`), attached to the same port as the HTTP server — no separate WS process
- **Testing:** Playwright E2E (multi-context, real DB + Redis, no mocks)
- **Deployment:** Docker Compose + Cloudflare Tunnel (no reverse proxy container needed)
- **Card data:** REST Against Humanity API (`https://restagainsthumanity.com/api/v2/`) seeded at server start

### Design reference

The original Claude Design HTML prototype is preserved in `docs/design-reference/` for pixel-perfect implementation reference. Specifically:

- `docs/design-reference/project/styles.css` + `scenes.css` + `stats.css` — design token source-of-truth
- `docs/design-reference/project/screens.jsx` — component logic to port

**Do not implement** `docs/design-reference/project/tweaks-panel.jsx` or `app.jsx`'s `TweaksPanel` block — these are meta-UI for the design tool, not the real app.

---

## Authentication & Session Lifecycle — ✅ DONE

**Session-only (Jackbox-style).** No user accounts, no passwords.

### Join flow (HTTP first, then WebSocket)

1. **HTTP `POST /api/games/$code/join`** — body `{ username, role: "player"|"spectator", anonId }`. Server:
   - Validates room exists, has capacity, handle is unique in the session
   - Generates `playerId` via `cuid2` (`@paralleldrive/cuid2`) — Drizzle column default
   - Inserts row in `game_players` (status: `active` | `queued` | `spectator`; stores `posthog_anon_id = anonId`)
   - Returns `{ playerId, sessionToken, status: PlayerStatus, gameStatus: SessionStatus }`
2. **Client writes `localStorage.cab_session`** = `{ roomCode, playerId, sessionToken, username, role }`
3. **WebSocket connects** to `/api/games/$code/ws` and immediately sends `{ type: "auth", sessionToken }` to register the socket against the existing player
4. **Server validates `sessionToken`**, binds socket → player

`sessionToken` = HMAC-signed `{ playerId, roomCode, issuedAt }`. Verified server-side without DB lookup. Expires when room expires (24h Redis TTL).

### Reconnect flow

On any page mount:

1. Read `localStorage.cab_session`. If missing → no active game.
2. If present and current URL doesn't match active game → always redirect to `/games/$code/lobby`. The lobby route then inspects game status (via WS `state_snapshot`) and redirects to `/session` if status is `active` or `paused`, or `/end` if `ended`. Single navigation source-of-truth in the lobby route.
3. Open WebSocket, send `{ type: "auth", sessionToken }`.
4. Send `{ type: "rejoin" }`. Server responds with `state_snapshot`.
5. Show `Reconnecting…` overlay until snapshot received.
6. **Grace window: 30s.** See "Disconnect timeline" below.

### Disconnect timeline

Three layered timeouts govern when a player is treated as permanently dropped:

| Step | Trigger                       | Duration                | What happens                                                                                         |
| ---- | ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | Client sends `ping` every 15s | —                       | Keepalive                                                                                            |
| 2    | Server silence detection      | 45s with no `ping`      | Server force-closes WS (handles half-open TCP)                                                       |
| 3    | Grace window starts           | `GRACE_WINDOW_MS` (30s) | Player marked `status: "grace"` in Redis. Hand preserved. Other clients see them with dimmed avatar. |
| 4    | Grace expires                 | —                       | Player `status: "dropped"`. Hand returned to deck. `player_left` broadcast.                          |

**Total tolerance:**

- Clean disconnect (browser close, network drop with TCP RST): step 3 fires immediately → 30s grace
- Half-open connection (Wi-Fi network change, dead VPN): step 2 fires first (45s) → step 3 (30s) → up to 75s

Step 3 starts immediately on WS close event — no waiting for keepalive timeout when the disconnect is clean.

### Logout / leave

Client clears `cab_session` on **explicit Leave button**, on **"Go home" from the end screen**, or on **`auth_error`**. The session **persists through `game_over` and the end screen** so the "Play again" button can reuse the handle and `anonId`. Server removes player from Redis on `leave` message.

### Security notes

- **CSRF:** Not required. `sessionToken` lives in `localStorage` and is sent via `Authorization: Bearer` header (not cookies). Same-origin policy + bearer token = no CSRF attack surface.
- **Token replay (accepted risk):** Tokens are HMAC-bound to `playerId` for 24h. If leaked (e.g. shared screenshot, browser extension), an attacker can impersonate that player until the room expires. This is acceptable for a party game's threat model; not worth adding rotation or IP-binding which would break mobile users on flaky networks.
- **Rate limiting:** Per-IP sliding-window limits using Redis: `10 join attempts/min/IP`, `5 game-create attempts/hour/IP`, `60 WS messages/min/connection`. Exceeding returns HTTP 429 / WS `error` with code `rate_limited`. Cloudflare's WAF provides upstream DDoS protection; app-level limits handle abuse from legitimate clients.

---

## HTTP API — ✅ DONE

All endpoints under `/api`. JSON request and response bodies. `Authorization: Bearer <sessionToken>` header required for any endpoint operating on an existing player (except `join`).

### Public endpoints

| Method | Path          | Body | Returns                                                             | Notes                                                                                                      |
| ------ | ------------- | ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`    | —    | `200 { db: "ok", redis: "ok", activeGames: N, uptime: T }` or `503` | Used by Docker healthcheck. Returns 503 if DB or Redis is unreachable.                                     |
| GET    | `/api/packs`  | —    | `200 { packs: Pack[] }`                                             | List of available card packs from DB. Cached 5 min.                                                        |
| GET    | `/api/stats`  | —    | `200 { ...StatsResponse }`                                          | Aggregated stats for `/stats` page. Cached 5 min.                                                          |
| GET    | `/api/config` | —    | `200 { posthogKey, posthogHost }`                                   | Client bootstraps PostHog by fetching its key here. Avoids exposing the key via Vite build env. Cached 1h. |

### Game lifecycle endpoints

| Method | Path                     | Body                                                | Returns                                                                           | Notes                                                                                                                                                                                               |
| ------ | ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/games`             | `{ username, anonId, config: GameConfig }`          | `201 { roomCode, playerId, sessionToken }`                                        | Creates a game, inserts host player. Rate-limited per IP. `anonId` (client's PostHog distinct_id) is persisted on the player row for server-side event attribution.                                 |
| POST   | `/api/games/$code/join`  | `{ username, anonId, role: "player"\|"spectator" }` | `200 { playerId, sessionToken, status: PlayerStatus, gameStatus: SessionStatus }` | Joins an existing game. `gameStatus` tells client whether to wait in lobby or join queued. Returns 409 if username taken in session, 410 if game ended, 423 if room full and player role requested. |
| POST   | `/api/games/$code/start` | — (auth required)                                   | `204 No Content`                                                                  | Host-only. Server responds immediately, then emits `game_started` over WS. Returns 403 if not host, 409 if `<3 active players` or already started.                                                  |
| POST   | `/api/games/$code/leave` | — (auth required)                                   | `204 No Content`                                                                  | Explicit leave outside WS. Removes player from game.                                                                                                                                                |

### Error response shape

All errors: `{ error: string, code: ErrorCode, details?: any }` with appropriate HTTP status. `code` matches the WS `ErrorCode` enum.

---

## Routes — ✅ DONE

| Path                   | Screen                              |
| ---------------------- | ----------------------------------- |
| `/`                    | Home                                |
| `/stats`               | Stats (public)                      |
| `/games/create`        | Create game                         |
| `/games/join`          | Join game                           |
| `/games/$code/lobby`   | Lobby (pre-game + mid-game waiting) |
| `/games/$code/session` | Game session                        |
| `/games/$code/end`     | End screen / final scoreboard       |

### Inter-route transitions

- `/games/create` → `POST /api/games` (create room) → redirect to `/games/$code/lobby`
- `/games/join` → `POST /api/games/$code/join` → redirect to `/games/$code/lobby`
- Host clicks "Start game" → `POST /api/games/$code/start` → server emits `game_started` over WS → **all lobby clients navigate to `/games/$code/session`**
- On `game_over` event → all session clients navigate to `/games/$code/end`
- Late joiner in lobby receives `round_end` with their playerId in `activatedPlayers[]` → client navigates to `/games/$code/session`

---

## Visual Design System — ✅ DONE

Strict monochrome black-and-white. No colour accents.

### Fonts (Google Fonts)

- `Geist` — body, UI
- `Bricolage Grotesque` — display headings
- `Geist Mono` — room codes, metadata, labels

### Design Tokens (`src/styles.css`)

```css
--black, --black-2 (#0a0a0a), --black-3 (#141414)
--ink (#1a1a1a), --ink-2 (#242424)
--white, --white-2 (#f7f7f5), --paper (#ffffff)
--gray-1…gray-5
--hairline / hairline-2 / hairline-3  (rgba white at 10/20/34%)
--radius-sm/md/lg/xl  (6/10/14/18px)
--shadow-card, --shadow-paper
--font-display, --font-body, --font-mono
```

### Card Sizes (5:7 aspect ratio — standard poker proportions)

| Class      | Width |
| ---------- | ----- |
| `.card-sm` | 140px |
| `.card-md` | 200px |
| `.card-lg` | 280px |
| `.card-xl` | 360px |

### Component Classes (semantic CSS, not Tailwind utilities)

`.btn`, `.btn-primary`, `.btn-ghost`, `.btn-dark`, `.btn-lg`, `.btn-sm`, `.btn-block`
`.card`, `.card-prompt`, `.card-response`, `.card-back`, `.card-clickable`, `.card-selected`
`.sheet`, `.sheet-hd`, `.sheet-title`, `.sheet-sub`
`.input`, `.field`, `.stepper`, `.seg`, `.check-card`
`.avatar`, `.avatar-lg`, `.avatar-sm`
`.scoreboard`, `.score-chip`, `.hand-dock`, `.hand`, `.subs-grid`
`.topbar`, `.topbar-minimal`, `.brand`, `.pill`

### Animation Timing Constants

Centralise in `src/lib/timing.ts`:

```ts
export const TIMING = {
  DEAL_MS: 550, // card dealing animation
  FADE_IN_MS: 400, // scene fade-in: applied via .fade-in class on scene mount
  // staggered for child elements at 0.02s/0.08s/0.14s/0.20s/0.26s
  REVEAL_STAGGER: 700, // ms between sequential card reveals
  WINNER_PAUSE: 2600, // post-winner-picked, before next round
  RECONNECT_TOAST: 250, // debounce for "Reconnecting…" overlay
  GRACE_WINDOW_MS: 30000, // server-side disconnect grace (DB constant)
} as const
```

E2E tests import these to time their assertions deterministically.

### Prompt Card Blank Rendering

Black prompt cards encode blanks as the literal substring `__________` (10 underscores). The `PromptText` React component splits text on this marker and renders each blank as a `<u>` element styled with `border-bottom: 2px solid currentColor; padding: 0 0.35em; min-width: 1.2em; display: inline-block; white-space: nowrap;` (matches design's `.card-prompt .card-text u` rule). During reveal phase, blanks remain empty — winning fills are shown in the response card, not slotted back into the prompt.

### Accessibility

Preserve from design prototype (do not regress):

- `role="radio"` + `aria-checked` on join-as picker, segmented controls
- Avatar `title={name}` tooltips
- Buttons have explicit `type="button"` to prevent form submission
- All interactive elements keyboard-accessible (no `div onClick` without `tabIndex` + `onKeyDown`)
- Live regions (`aria-live="polite"`) for state announcements ("You submitted", "Czar is reading", "Winner picked")
- Card text uses `text-wrap: pretty` + `overflow-wrap: break-word` for resilient layout

### Mobile Responsiveness

Design has breakpoints at `1100px`, `860px`, `720px`, `420px`. All preserved verbatim in `src/styles.css`. Mobile-specific behaviour:

- Hand dock scrolls horizontally with snap (vs. fan on desktop)
- Scoreboard scrolls horizontally
- Card-xl resizes from 360px → 280px → 260px

---

## Screens — ⚠️ PARTIAL (route stubs exist; full game UI components not yet implemented)

### 1. Home (`/`)

- Large display headline: "A horrible card game for _horrible_ friends."
- Hero card stack (1 prompt card + 2 response cards, rotated/fanned)
- CTAs: Create a game (primary), Join a game (ghost), See the stats (ghost)
- Scrolling marquee strip at bottom

### 2. Create Game (`/games/create`)

- Handle input (username, 2–20 chars)
- Steppers: Max players (3–10), Rounds to win (3–20)
- Segmented: Round timer (30s / 60s / 90s / Off)
- Card packs grid (Core locked, others toggleable) — loaded from DB via `GET /api/packs`. The default `Core` pack ID is resolved at runtime by name match (`name LIKE 'CAH Base Set%'`).
- House rules:
  - **Modal rules** (sub-section, radio-group — pick at most one): God Is Dead, Survival of the Fittest, Serious Business. Selecting one greys out the others; "None" option deselects all.
  - **Orthogonal rules** (sub-section, checkboxes — any combination): Rebooting the Universe, Packing Heat, Rando Cardrissian, Never Have I Ever, Happy Ending.
- Sticky right panel: live summary + "Create lobby" button (disabled until handle ≥2 chars; also disabled if any conflict — though UI prevents these)

### 3. Join Game (`/games/join`)

- Room code input (uppercase, monospace, 6 chars)
- Handle input
- Join-as picker: Player / Spectator (auto-forced to Spectator if room is full)
- If room full: banner explains spectator-only

### 4. Lobby (`/games/$code/lobby`)

Two states:

**Pre-game:** Room code card (large) with two buttons:

- **"Copy code"** — copies just the formatted code (e.g. `B7K-9MV`)
- **"Copy link"** — copies `https://<host>/games/join?code=B7K-9MV` (recipient lands on join screen with code pre-filled)

Player list with HOST/YOU badges and a small green presence dot per player (no ready/not-ready distinction — all joined players are automatically ready). Empty seats (dashed), spectator row, game summary panel (packs, rules, settings), host sees "Start game" (disabled until ≥3 players), non-host sees "Waiting for host…" spinner.

**Mid-game waiting:** Same layout but shows "Game in progress — you'll join after this round." Live scoreboard visible (read-only). On `round_end` event containing this player's ID in `activatedPlayers[]`, the client navigates to `/games/$code/session`.

### 5. Game Session (`/games/$code/session`)

**Phases:**

| Phase        | Player view                                                       | Czar view                                   |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------- |
| `picking`    | Prompt card hero (centered), hand dock at bottom, submit button   | Prompt hero, "Waiting for players…" spinner |
| `waiting`    | Prompt hero, submission progress pips, "Waiting on others…"       | Same                                        |
| `judging`    | Face-down card grid, "Judge is reading" note                      | Face-down grid, "Start reveal →" button     |
| `reveal`     | Cards flip one-by-one, winner highlighted                         | Click revealed card to pick winner          |
| `transition` | Winner badge + +1 point, server-controlled pause, then next round | Same                                        |

**Phase timing is server-controlled.** The server schedules transitions (`reveal_start`, `card_revealed`, `round_end`, `round_started`) and emits events at the right time. Clients only animate based on received events — they do not run their own phase timers. This prevents drift across clients.

**Layout:**

- Sticky topbar: ROUND XX pill, timer pill, **host-only ⋯ menu** (when `happy_ending` rule active — opens dropdown with "End game early — make a haiku"), Leave button
- Scoreboard row (current Czar highlighted in white chip)
- Stage: prompt card left (xl size), submissions grid right
- Hand dock: sticky bottom, **10 cards** fanned per official CAH rules (design's 7-card fan widened to fit 10 — increase overlap or scroll horizontally on narrow screens), selected cards lift

**Multi-blank cards:** Black cards with `pick: 2` or `pick: 3` require multiple white card selections. Cards flatten into the grid with player-number badges. Real CAH packs typically only include `pick: 1` and `pick: 2`; engine supports `pick: 3` for forward compatibility with user-generated content.

**Game config visibility.** The packs/rules/settings panel from the Lobby is **not shown during the game session**. Once gameplay starts, the screen focuses on the prompt and hand. Game config is implicit through the gameplay (e.g., players see the rule's effect, like "redraw" buttons appearing under Rebooting the Universe).

### 6. Stats (`/stats`)

- Headline tiles: games played, rounds judged, cards submitted, avg players, avg spectators, avg session
- Sparkline: games per day (30d)
- Bar chart: lobbies by player count
- Rando Cardrissian win stats
- Horizontal bar charts: pack adoption % (**Core pack excluded — always 100%, would skew the chart**), house rules adoption %
- Top 5 most-picked response cards leaderboard

**Empty state.** Fresh deployment with zero games shows: "No games played yet. Come back after some chaos." All charts hidden until ≥1 game completes.

**Data source.** Aggregated from Postgres (not Redis — Redis state is ephemeral). Computed by a server function at request time, cached for 5 minutes via `Cache-Control` header. Frontend-first phase: mocked from `STATS_DATA` constant matching the design's shape.

### 7. End Game (`/games/$code/end`)

- Final scoreboard with winner callout
- "Play again" (creates new lobby with same settings) and "Go home" buttons

---

## State Management — ✅ DONE

### `GameContext` (pre-game draft — survives Create → Lobby navigation)

Holds a `GameDraft` (see Type Definitions). Defaults: `maxPlayers: 6`, `roundsToWin: 7`, `timer: "60s"`, `packs: []` (initially empty — Create screen loads available packs via `GET /api/packs` on mount and auto-selects the Core pack by name match), `rules: []`.

### Session persistence (`localStorage`)

Key `cab_session`: stores a `CabSession` (see Type Definitions). Set on join/create, cleared on game end or `auth_error`. Read on app init to redirect back to active game.

### Multiple game membership

If a user already has a `cab_session` in localStorage and navigates to `/games/join` for a different room code, the join screen detects the conflict and shows a modal: "You're already in game `XXX-XXX`. Leave it first?" — Leave/Cancel buttons. Leave sends `{ type: "leave" }` over the existing socket, clears `cab_session`, then proceeds to the new join. This prevents accidental disconnection from an in-progress game.

### Settings immutability

Once `POST /api/games/$code/start` succeeds, game config (packs, rules, roundsToWin, maxPlayers) is frozen. Host cannot modify mid-game. The `game_sessions.config` JSON is the source of truth and is locked at start.

---

## Type Definitions — ✅ DONE

All shared types live in `src/lib/types.ts`. Used by both client and server.

```ts
// ── Player & role ─────────────────────────────────────────────
type Role = 'player' | 'spectator'

type PlayerStatus =
  | 'active' // in the game, taking turns
  | 'queued' // mid-game joiner; activates next round
  | 'spectator' // watching only
  | 'grace' // disconnected, within GRACE_WINDOW_MS, still recoverable
  | 'dropped' // permanently removed (grace expired or explicit leave)

type GamePlayer = {
  id: string
  username: string
  role: Role
  status: PlayerStatus
  score: number
  isHost: boolean
  isRando: boolean // synthetic Rando Cardrissian player
  discardsUsed: number // for Never Have I Ever (capped at 3 per game)
  joinedAt: string // ISO timestamp
}

type PlayerScore = {
  playerId: string
  username: string
  score: number
  isJudge: boolean // for current round
  isRando: boolean
}

// ── Cards ─────────────────────────────────────────────────────
type Card = {
  id: string // server-side card cuid2
  text: string // plain text for white cards; black cards have blanks pre-normalised as __________
}

type BlackCard = Card & { pick: 1 | 2 | 3 }

type Hand = Card[] // exactly 10 white cards (11 during Packing Heat on pick:2)

// ── Submissions ───────────────────────────────────────────────
type Submission = {
  submissionId: string // server-generated opaque string. The submissionId→playerId mapping is hidden from clients until reveal.
  fills: Card[] // length matches prompt's `pick`; order = submitter's order
  playerId?: string // omitted until reveal; revealed to all post-reveal
  rank?: 1 | 2 | 3 // only present in Serious Business mode
  eliminated?: boolean // only present in Survival mode
}

// ── Phase & session state ─────────────────────────────────────
type GamePhase =
  | 'picking' // players submitting cards
  | 'waiting' // you've submitted, waiting on others
  | 'judging' // czar choosing (or all-players voting in God Is Dead)
  | 'eliminating' // Survival of the Fittest takedown rounds
  | 'ranking' // Serious Business top-3 ranking
  | 'reveal' // cards being revealed
  | 'transition' // winner shown, brief pause before next round

type SessionState = {
  phase: GamePhase
  round: number
  prompt: BlackCard
  czarId: string | null // null during God Is Dead
  hand?: Hand // omitted for spectators; only sent to the hand's owner
  submissions: Submission[] // server pre-shuffles between players
  scores: PlayerScore[]
  revealIndex: number
  winnerId: string | null
  eliminationTurnPlayerId?: string // Survival of the Fittest current turn
  voteTally?: Record<string, number> // God Is Dead live votes
  ranking?: Submission[] // Serious Business top-3 (rank+points filled)
}

// ── Session-level status ──────────────────────────────────────
type SessionStatus = 'lobby' | 'active' | 'paused' | 'ended' | 'abandoned'

// ── House rule IDs ────────────────────────────────────────────
type ModalRuleId = // mutually exclusive — at most one
  | 'godmode' // God Is Dead
  | 'survival' // Survival of the Fittest
  | 'serious_business' // Serious Business

type OrthogonalRuleId = // stackable in any combination
  'rebooting' | 'packing_heat' | 'rando' | 'never_have_i_ever' | 'happy_ending'

type RuleId = ModalRuleId | OrthogonalRuleId

// ── Config (persisted in game_sessions.config JSONB) ──────────
type GameConfig = {
  maxPlayers: number // 3–10
  roundsToWin: number // 3–20
  timer: '30s' | '60s' | '90s' | 'Off'
  packs: string[] // pack IDs (resolved at game-create time from DB)
  rules: RuleId[] // ≤1 modal rule + any orthogonal rules
}

// ── Game-over outcome ─────────────────────────────────────────
type GameOverMode =
  | 'normal' // first player reached roundsToWin
  | 'happy_ending' // host triggered early end via "Make a Haiku"
  | 'rando_won' // synthetic Rando player has highest score
  | 'deck_exhausted' // ran out of black cards before any player won
  | 'abandoned' // all players dropped past grace; sweeper marked ended

// ── Error codes (used by WS error and HTTP 4xx responses) ─────
type ErrorCode =
  | 'not_authorized' // auth failed or missing
  | 'invalid_token' // sessionToken HMAC mismatch
  | 'player_dropped' // grace window expired
  | 'spectator_action' // spectator tried to send a game action
  | 'invalid_state' // event sent in wrong phase
  | 'rate_limited' // too many requests
  | 'room_full' // tried to join as player when player slots full
  | 'room_not_found' // room code doesn't exist or expired
  | 'duplicate_username' // handle taken in this session
  | 'conflicting_rules' // game start with >1 modal rule
  | 'host_only' // non-host tried host-only action
  | 'score_too_low' // tried to Reboot the Universe with score < 1
  | 'internal_error'

// ── Pre-game draft (client-side only) ─────────────────────────
type GameDraft = GameConfig & {
  username: string // host or joiner's chosen handle
  roomCode?: string
  playerId?: string
  role?: Role
}

// ── localStorage shape ────────────────────────────────────────
type CabSession = {
  roomCode: string
  playerId: string
  sessionToken: string
  username: string
  role: Role
  anonId: string // PostHog distinct_id; stable per browser, set on first page mount
}
```

### Game session state on the client

`SessionState` is populated from WebSocket events; falls back to a full snapshot on reconnect.

---

## WebSocket Protocol — ✅ DONE

### Connection

`ws://<host>/api/games/<code>/ws`

### First message after connect

Always `{ type: "auth", sessionToken }`. Server validates the HMAC token and binds the socket to the player. Subsequent messages are accepted only after auth succeeds.

### Client → Server events

```
{ type: "auth",            sessionToken }          // first message, always
{ type: "rejoin" }                                 // request state_snapshot
{ type: "play",            cardIds[] }             // submit cards for current round
{ type: "gamble" }                                 // wager 1 point for extra submission (base mechanic)
{ type: "pick",            submissionId }          // czar picks winner (single-pick mode)
{ type: "rank",            ranking[] }             // czar's top-3 (Serious Business)
{ type: "vote",            submissionId }          // God is Dead mode
{ type: "eliminate",       submissionId }          // Survival of the Fittest
{ type: "redraw" }                                 // Rebooting the Universe
{ type: "confess_discard", cardId }                // Never Have I Ever
{ type: "leave" }                                  // explicit leave
{ type: "ping" }                                   // keepalive
```

All client messages are scoped to the socket's authenticated `playerId` + `roomCode` — clients never send these explicitly post-auth, eliminating spoof risk.

### Server → Client events

```
{ type: "auth_ok" }
{ type: "auth_error",       code: ErrorCode, message }
{ type: "state_snapshot",   state: SessionState }       // sent on rejoin
{ type: "player_joined",    player: GamePlayer }
{ type: "player_left",      playerId }
{ type: "game_started",     firstRound }
{ type: "round_started",    round, prompt: BlackCard, czarId: string|null, hand?: Hand }
{ type: "player_played",    playerId }                  // face-down ack to others
{ type: "player_gambled",   playerId }                  // notify others of a wager
{ type: "player_skipped",   playerId, round }           // timer expired before submission
{ type: "reveal_start" }
{ type: "card_revealed",    submissionIndex, fills: Card[] }
{ type: "round_won",        winnerId, submissionId, scores: PlayerScore[] }      // normal & God-Is-Dead resolution
{ type: "round_ranked",     ranking: Submission[], scoresDelta: Record<playerId, number> } // Serious Business
{ type: "elimination_turn", playerId }                  // Survival: whose turn to eliminate
{ type: "card_eliminated",  submissionId, byPlayerId }  // Survival
{ type: "vote_tally",       votes: Record<submissionId, number> } // God Is Dead live
{ type: "round_end",        activatedPlayers: string[], handsRefilled: Record<playerId, Hand> } // every mode ends with this
{ type: "game_over",        finalScores: PlayerScore[], winnerId, mode: GameOverMode }
{ type: "error",            code: ErrorCode, message }
{ type: "pong" }
```

`round_end` is the single source of truth for round termination across all modes. It always carries `handsRefilled` (each submitter's new full hand) so clients update their hand UI uniformly. Mode-specific events (`round_won`, `round_ranked`) precede `round_end` to describe the outcome; `round_end` finalizes scores and refills.

### Submission ordering

**Within a player's submission** (multi-blank cards): order is the submitter's chosen order, preserved by the server. The Czar reads them in that order ("Card 1: **\_**. Card 2: **\_**.") because the prompt is structured that way.

**Between players' submissions**: the server randomly permutes the submissions array before sending to anyone. Each gets a stable opaque `submissionId`. The mapping `submissionId → playerId` is kept server-side only until `reveal`. This prevents Czars from identifying who played what by submission order.

### Submission atomicity

Each player's submission writes to a single Redis hash field: `HSET game:{code}:round.submissions {playerId} {JSON}`. Single-key, single-op = atomic. Concurrent submissions from multiple players cannot race or corrupt each other. The `play` handler reads existing field first; if non-empty, treats as duplicate (no-op, returns existing ack).

### Submission deduplication

If a player sends `play` twice for the same round (network glitch, double-click), the server treats the second as a no-op (responds with same `player_played` ack, doesn't update Redis). Client UI uses optimistic local state to prevent UI confusion.

### Reconnect flow

1. Client connects, sends `auth`, then `rejoin`
2. Server validates `sessionToken`:
   - **Valid + player still in game** → responds with `auth_ok`, then `state_snapshot` (full current SessionState)
   - **Valid HMAC but player dropped past grace window** → responds with `auth_error: "player_dropped"`. Client clears `localStorage.cab_session` and redirects to `/` with a toast: "You were disconnected too long."
   - **Invalid HMAC / expired** → responds with `auth_error: "invalid_token"`. Client clears localStorage, redirects to `/`.
3. Client shows "Reconnecting…" overlay (debounced by `RECONNECT_TOAST` ms to avoid flash on fast reconnects) while awaiting snapshot. On `state_snapshot` arrival, client hydrates SessionState and dismisses the overlay.
4. Server grace window: `GRACE_WINDOW_MS` before treating disconnect as permanent drop

### Client-side reconnect backoff

When the WebSocket drops unexpectedly, client retries with exponential backoff: `1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s…` (caps at 30s). Infinite retries — never gives up automatically; user can manually leave via UI. Successful connect (`auth_ok` received) resets the backoff to 1s.

### Disconnect handling

| Who                                          | What happens                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regular player picking                       | Card pool returns their cards (if any submitted) on permanent drop; round continues with remaining players                                                                                     |
| Regular player judging                       | No action — they don't have an active role this round                                                                                                                                          |
| **Czar** during `picking` / `waiting`        | If permanent drop, round is voided: cards returned to hands, next player by join order becomes Czar, round restarts with a fresh black card. (No skip behavior — always restart for fairness.) |
| **Czar** during `judging` / `reveal`         | If permanent drop, server auto-picks a random submission as winner after grace window expires                                                                                                  |
| **Czar** during `eliminating` (Survival)     | Same as above — server auto-eliminates random remaining submissions until one wins                                                                                                             |
| **Czar** during `ranking` (Serious Business) | Same — server auto-ranks remaining unranked submissions randomly                                                                                                                               |
| Host (anyone)                                | "Host" flag transfers to next player by join order. Game continues normally.                                                                                                                   |
| All players disconnected                     | Game transitions to `status: "paused"`. Persists in Redis (AOF) until any player rejoins or 24h TTL expires (becomes `abandoned`).                                                             |

### Keepalive

Client sends `ping` every 15s; server responds `pong`. After 45s of silence, server treats client as disconnected (starts grace window).

---

## Game Rules Engine — ✅ DONE

### Core loop

1. Deal 10 white cards to each active player at game start
2. Each round: rotate Czar, deal new black card from shuffled deck
3. Non-czar players submit `pick` white cards (1, 2, or 3 per black card) — **submission order matters for multi-pick cards** (the Czar reads them in the order submitted)
4. Czar shuffles answers and reads each combination dramatically (re-reading the prompt before each, per official rules)
5. Round resolution (mode-dependent):
   - **Normal / God Is Dead:** Czar picks (or vote-majority resolves) → winner gets the black card as 1 Awesome Point. Server emits `round_won`.
   - **Survival of the Fittest:** Players eliminate cards until 1 remains → that submitter wins 1 point. Server emits `round_won`.
   - **Serious Business:** Czar ranks top 3 → +3/+2/+1 points to the respective players. Server emits `round_ranked`.
6. **Round termination & hand replenishment (uniform across modes):** Server emits `round_end` containing `handsRefilled: Record<playerId, Hand>` — every submitter's hand topped back up to 10 from `deck:white`. Discards (winners + losers) moved to `discard:white`. Black card moved to `discard:black`. `round_end` also carries `activatedPlayers[]` if any mid-game joiners are now active.
7. First to `roundsToWin` Awesome Points wins → `game_over`

### Gambling (base mechanic, available except in modal house-rule games and on round 1)

Before submitting their primary card(s) for the round, any non-Czar player with `score >= 1` may **wager 1 Awesome Point** to play an additional `pick` cards (effectively a second submission for the same prompt). Available only in normal mode rounds from round 2 onward — disabled in any modal house-rule game (God Is Dead, Survival of the Fittest, Serious Business).

- WS event: `{ type: "gamble" }` — sent before `play`. Server decrements score by 1, deals `pick` extra cards to the player, allows them to submit a second submission.
- Each of the player's submissions is treated independently in the Czar's view (they don't know they belong to the same player until reveal).
- **If any of the player's submissions wins:** they keep their wagered point and gain 1 from winning (net +1, same as normal).
- **If neither wins:** the wagered point transfers to the round winner.
- Gambling is disabled in `God Is Dead` mode (no Czar to read), `Survival of the Fittest` mode (wagered cards can be eliminated, broken point math), `Serious Business` mode (point math conflicts with rank-based scoring), and on round 1 (no points to wager).

### Czar selection

A stable `czarOrder` array is maintained in Redis at `game:{code}:czarOrder` (list of playerIds in turn order, set at game start from active players sorted by `joined_at`). The Czar rotation does **not** recompute from live arrays — it traverses this stable list.

**Round 1 Czar is chosen randomly** via `src/lib/rng.ts` — pick an index into `czarOrder` and record it as the starting offset. Subsequent rounds increment from there: `czar[N] = czarOrder[(round1Idx + N - 1) % czarOrder.length]`.

**Drops:** A player who drops (`status: "dropped"`) stays in `czarOrder` but is marked skipped. When the rotation lands on a dropped player, the engine increments past them to the next non-dropped entry. This keeps the rotation order stable for all other players.

**Mid-game joiners:** Appended to the end of `czarOrder` when activated (during `round_end`). They join the rotation cleanly without disrupting existing order. They first Czar 2+ rounds after activation (one round as regular player first).

Tests seed the RNG via `CAB_RNG_SEED` env var so the entire Czar sequence is deterministic.

### Randomness (seedable PRNG)

All non-cryptographic randomness goes through `src/lib/rng.ts`, which wraps the [`seedrandom`](https://www.npmjs.com/package/seedrandom) library. Exposes:

```ts
export function randomInt(min: number, max: number): number // inclusive min, exclusive max
export function shuffle<T>(array: T[]): T[] // Fisher-Yates, returns new array
export function pick<T>(array: T[]): T // single random element
```

- In production, the PRNG is seeded once at boot from `crypto.randomBytes(16)`. No determinism.
- In tests, `CAB_RNG_SEED` env var is the seed → fully reproducible outcomes (first Czar, deck shuffle, Rando card picks, modal-rule random choices).
- Crypto-strength randomness (room codes, sessionToken HMAC nonces) uses `crypto` directly — never goes through this wrapper.

### Card pool

- At game create: host selects packs. Pack list stored in `game_sessions.config.packs`.
- At game start (`POST /api/games/$code/start`): server materializes shuffled `black_deck` and `white_deck` in Redis from the union of selected packs.
- Pool is frozen at start — adding packs mid-game has no effect.
- Two Redis lists: `game:{code}:deck:black` and `game:{code}:deck:white`.

### Deck exhaustion & discards

- **Discard policy:** When a round ends (winner picked), all submitted white cards — winning and losing — move from `game:{code}:round.submissions` to `game:{code}:discard:white`. Submitters' hands replenish by drawing fresh cards from `deck:white`. The black card just played also moves to a `discard:black` list (informational; black discards never reshuffle).
- **White cards run low:** When `LLEN game:{code}:deck:white < activePlayers * 3`, server shuffles `discard:white` back into `deck:white`, clears the discard list. Deal continues seamlessly.
- **Black cards exhausted:** Game ends naturally — server emits `game_over` with the current leader as winner. Edge note: a fresh setup loading all CAH packs has thousands of black cards; this is practically rare.

### Round timer expiration

When a `roundTimer` is configured (30s/60s/90s) and the timer reaches 0 while a player hasn't submitted, that player **is skipped for the round**:

- Server marks them with an empty submission (no cards consumed from their hand)
- Czar judges only the players who submitted in time
- The skipped player participates normally next round
- WS event: `{ type: "player_skipped", playerId }` — UI shows their score chip dimmed/struck through for that round
- If only 1 or 0 players submitted before timer expiry, the round is voided (no winner, no point awarded), and the same Czar runs the round again with a new black card

### Submission order randomization

When a round transitions to `judging`, the server randomly permutes the submissions array and assigns each a stable `submissionId`. The mapping `submissionId → playerId` is kept server-side only until `reveal`. The Czar's view shows them in the shuffled order; they cannot infer who submitted what.

### House Rules

All rules below are from the official 2014 CAH rulebook (`https://s3.amazonaws.com/cah/CAH_Rules.pdf`):

| Rule                    | ID                  | Implementation                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rebooting the Universe  | `rebooting`         | Player action: spend 1 point → return any number of white cards, redraw to 10. **Allowed during `picking` and `transition` phases only.** Requires `score >= 1`. Server rejects with `error: "invalid_state"` if attempted in any other phase.                                                                                                                 |
| Packing Heat            | `packing_heat`      | On `pick: 2` black card → deal 1 extra white card to each player before submission phase. Hand becomes 11; submitting returns to 10.                                                                                                                                                                                                                           |
| Rando Cardrissian       | `rando`             | Auto-submitted random white card each round, attributed to imaginary player "Rando Cardrissian". If Rando wins the game overall, `game_over.mode = "rando_won"` triggers the shame screen variant.                                                                                                                                                             |
| God Is Dead             | `godmode`           | No Czar. All players submit, then all players vote. Each player gets one vote, cannot vote for own submission. Most votes wins. **Tie-breaking:** Re-vote between tied submissions. If tie persists 2×, random pick among tied. Disables Gambling.                                                                                                             |
| Survival of the Fittest | `survival`          | After all submissions are in, players take turns (in join order, skipping Czar) eliminating one submission each. Last submission remaining wins. UI: each player's turn shows a "remove one" prompt with all submissions face-up; clicking eliminates it.                                                                                                      |
| Serious Business        | `serious_business`  | Instead of single winner per round, Czar ranks the **top 3 submissions**. 1st = 3 points, 2nd = 2 points, 3rd = 1 point. Track running tally. Final winner = highest total. Disables Gambling. UI: Czar's reveal screen shows 1/2/3 podium slots; cards dragged or click-numbered into slots.                                                                  |
| Never Have I Ever       | `never_have_i_ever` | Players may discard any white card from their hand with a public confession ("I don't get this one"). **Allowed during `picking` and `transition` phases only.** Server replaces with a new card and broadcasts `cab_rule_triggered`. Limited to 3 discards per game per player (tracked in `discards_used`). WS event: `{ type: "confess_discard", cardId }`. |
| Happy Ending            | `happy_ending`      | Host may end game early. When triggered, the final black card is forced to a "Make a Haiku" card (haikus need not be 5-7-5; just read dramatically per the official rule). Winner of the final round wins regardless of point totals.                                                                                                                          |

---

## Spectator Permissions — ✅ DONE

| Phase                      | Spectator can see                           | Spectator cannot see                   |
| -------------------------- | ------------------------------------------- | -------------------------------------- |
| Lobby                      | Player list, room code, settings            | (everything visible)                   |
| `picking`                  | Prompt, who has submitted (face-down count) | Anyone's hand, anyone's submitted card |
| `waiting`                  | Prompt, submission progress                 | Submitted card content                 |
| `judging`                  | Prompt, face-down submissions               | Card content                           |
| `reveal`                   | Prompt, revealed cards, winner              | (parity with players)                  |
| `transition` / `round_end` | New scores, winner                          | —                                      |
| `game_over`                | Final scoreboard                            | —                                      |

Spectators cannot send game actions (`play`, `gamble`, `pick`, `rank`, `vote`, `eliminate`, `redraw`, `confess_discard`). Server rejects these events with `error` code `spectator_action` if sent by a spectator.

---

## Mid-Game Join — ✅ DONE

1. Player joins via `/games/join` while game is in progress
2. Server adds them to `game:{code}:players` with status `queued`, returns `playerId`
3. Client navigates to `/games/$code/lobby` (in mid-game-waiting state)
4. Server emits `player_joined` to all clients
5. On `round_end`, server moves all `queued` players to `active`, deals each a starting hand of 10, emits `round_end` with `activatedPlayers[]`
6. Each newly-activated client receives the event, sees their own `playerId` in `activatedPlayers[]`, navigates to `/games/$code/session`
7. New player enters Czar rotation 2 rounds later (one round as regular player first — see Czar selection)

---

## Card Data Seeding — ✅ DONE

### When

On server start in `src/lib/seed.ts`. Runs asynchronously — does not block server boot. Server is operational immediately; gameplay routes return 503 until seed completes if DB has zero packs.

### What

1. `GET https://restagainsthumanity.com/api/v2/packs` — list of pack names
2. For each pack (sequential, ~50 packs): `GET /cards?packs=<name>&includePackNames=true`
3. Normalise black card text: replace `_` with `__________` (10 underscores) to match render conventions
4. Upsert into `packs`, `black_cards`, `white_cards` (idempotent via `ON CONFLICT DO NOTHING` on natural keys: `packs.slug`; `(pack_id, text, pick)` for black_cards; `(pack_id, text)` for white_cards)
5. Log: `Seeded N packs, M black cards, K white cards in T seconds`

### Resilience

- Retry with exponential backoff (1s, 2s, 4s, max 30s) on transient errors
- If REST AH API is completely down at startup, log warning and continue with whatever's in the DB — gameplay works with cached packs
- If DB is empty AND API is down, gameplay routes return 503 "No card data available" until seeding succeeds (background retry every 5 min)

---

## Database Schema (Drizzle) — ✅ DONE

```
packs          — id, name, slug (unique), card_count, created_at
black_cards    — id, pack_id (fk), text, pick (CHECK pick IN (1,2,3)), unique(pack_id, text, pick)
white_cards    — id, pack_id (fk), text,                                unique(pack_id, text)

game_sessions  — id (cuid2), code (CHAR(6), unique — stored without dash, e.g. 'B7K9MV'), status, config JSONB,
                 host_player_id (nullable FK), created_at, last_activity_at, ended_at,
                 winner_player_id (nullable FK), end_mode (nullable; ENUM same as GameOverMode)
                 status ENUM: 'lobby' | 'active' | 'paused' | 'ended' | 'abandoned'
                 end_mode ENUM: 'normal' | 'happy_ending' | 'rando_won' | 'deck_exhausted' | 'abandoned'

game_players   — id (cuid2), session_id (fk), username, role, score, status, is_host, is_rando,
                 discards_used INT DEFAULT 0, posthog_anon_id (text, nullable — PostHog distinct_id), joined_at
                 status ENUM: 'active' | 'queued' | 'spectator' | 'grace' | 'dropped'
                 unique(session_id, username)                          -- handles unique per room
                 partial unique(session_id) WHERE is_rando = true     -- at most one Rando per game

game_rounds    — id, session_id (fk), round_num, black_card_id, czar_player_id (nullable for God Is Dead),
                 winner_player_id (nullable FK; for Serious Business = top-ranked player),
                 winning_submission_fills JSONB,
                 ranking JSONB (nullable, only set in Serious Business mode: [{playerId, fills, rank, points}]),
                 vote_tally JSONB (nullable, only set in God Is Dead: {submissionId: count}),
                 played_at
                 unique(session_id, round_num)

INDEX idx_sessions_last_activity ON game_sessions (last_activity_at) WHERE status IN ('active', 'paused')  -- sweeper job query
INDEX gin_winning_fills ON game_rounds USING gin (winning_submission_fills)  -- speeds up top-cards stats query
```

### `last_activity_at` and stale-game sweeper

`last_activity_at` is updated on every WS message and HTTP API call for the session. A background job (`src/lib/sweeper.ts`) runs via [`node-cron`](https://github.com/node-cron/node-cron) scheduled at `*/30 * * * *` (every 30 min). Scheduled at process boot from the server entry point. Sweep query:

- Find sessions with `status IN ('active', 'paused')` AND `last_activity_at < now() - INTERVAL '6 hours'` AND zero present players in Redis
- Mark these as `status='abandoned'`, `end_mode='abandoned'`, set `ended_at = now()`
- Prevents orphan rows from games that died without a clean `game_over`

### Room code storage and display

- DB stores raw 6 chars: e.g. `B7K9MV` (no dash, no padding)
- URL paths use raw form: `/games/B7K9MV/lobby`
- Display layer inserts dash for human reading: rendered as `B7K-9MV`
- Input fields accept either form: `B7K-9MV`, `b7k9mv`, `b7k 9mv` all normalize to `B7K9MV` server-side

### Host FK chicken-and-egg resolution

`game_sessions.host_player_id` is `NULL`-able and unset at row creation. The flow:

1. `INSERT INTO game_sessions (code, config, status='lobby') VALUES (...)` returns `sessionId`
2. `INSERT INTO game_players (session_id, username, role, is_host=true) VALUES (sessionId, ...)` returns `playerId`
3. `UPDATE game_sessions SET host_player_id = playerId WHERE id = sessionId`

If the host leaves before any other players join, the session is marked `abandoned` and the orphan host row is acceptable.

### Rando Cardrissian as a synthetic player

When the `rando` house rule is enabled, the game-start handler inserts a `game_players` row with `username = "Rando Cardrissian"`, `is_rando = true`, `role = "player"`, `status = "active"`. Each round, the game engine generates Rando's submission by drawing random white cards from the deck (bypassing the normal hand mechanic — Rando has no persistent hand). The submission is stored against this synthetic player's ID. Rando's score tracks naturally; if Rando's row has the highest score at `game_over`, the emitted event sets `mode: "rando_won"` and the end screen renders the shame variant.

### Aggregations for Stats

Query-time aggregations with `Cache-Control: public, max-age=300`:

- `games_played_count` — `count(*) from game_sessions where status='ended'`
- `rounds_count` — `count(*) from game_rounds`
- `avg_players_per_game` — `avg(count) from (count game_players per session where is_rando=false)`
- `pack_adoption` — `count(distinct session_id) per pack` from `config->'packs'` JSONB (**excludes Core pack** — always-on, would always show 100%; chart only displays optional packs)
- `top_response_cards` — JSONB unnest of `winning_submission_fills`, grouped by text, top 5 by count (GIN index makes this fast)
- `rando_wins` — `count(*) from game_sessions where end_mode = 'rando_won'`
- `happy_ending_count` — `count(*) from game_sessions where end_mode = 'happy_ending'`

---

## Redis State Shape (per room) — ✅ DONE

```
game:{code}                hash: status, currentRound, totalRounds, czarIndex, hostId, config JSON, lastActivityAt
game:{code}:players        hash: playerId → GamePlayer JSON (includes discardsUsed)
game:{code}:round          hash with mode-aware fields:
                             blackCardId         (always)
                             czarId              (null in God Is Dead)
                             submissions         (always, JSON: playerId → Submission)
                             winnerId            (filled at round_won)
                             ranking             (only in Serious Business: JSON)
                             voteTally           (only in God Is Dead: JSON)
                             eliminationTurnPlayerId (only in Survival: current eliminator)
                             eliminations        (only in Survival: array of {submissionId, byPlayerId})
                             roundTimerExpiresAt (epoch ms, if timer enabled)
game:{code}:deck:black     list of card IDs (shuffled)
game:{code}:deck:white     list of card IDs (shuffled)
game:{code}:discard:white  list (for reshuffle when deck:white runs low)
game:{code}:discard:black  list (informational; no reshuffle)
game:{code}:hand:{id}      set of white card IDs (for player {id})
game:{code}:grace:{id}     string with PX expiry = GRACE_WINDOW_MS; set on disconnect
game:{code}:channel        pub/sub channel
```

All keys: 24h TTL on idle. Refreshed on any state mutation.

### Persistence

Valkey configured with AOF (`appendonly yes`) so a container restart recovers state up to the last write. RDB snapshots every 5 min as a backup. Volume mounted at `/data`.

---

## Room Code Generation — ✅ DONE

- 6 alphanumeric chars, uppercase, excluding ambiguous: `O`, `0`, `I`, `1`, `L` → alphabet = `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 chars)
- Total space: `31^6 ≈ 887M` — plenty.
- Generation: for each of 6 positions, `crypto.randomInt(0, 31)` to pick from the alphabet. `crypto.randomInt` uses rejection sampling internally → unbiased uniform distribution. Modulo-on-byte approaches have ~3% bias and are avoided.
- Collision check: `SET game:{code} ... NX EX 86400`. If `NX` fails, regenerate. Retry up to 5 times.
- Display format: `XXX-XXX` (dash inserted client-side only). Input accepts dashed/undashed/lowercase forms; normalized server-side.

---

## E2E Testing (Playwright) — ⚠️ PARTIAL (full-game + reconnect specs exist; house-rules, multi-blank, mid-game-join, mobile, a11y specs not yet written)

Test matrix using multi-context (separate browser contexts per player):

### Core flows

- [ ] Create game → lobby → start → full round → winner declared → next round begins
- [ ] Join as player → play through a round
- [ ] Join as spectator → cannot submit cards, sees all reveals
- [ ] Room full → auto-spectate on join
- [ ] Host leaves → host role transfers, game continues
- [ ] **Full 6-player 5-win game (golden-path end-to-end):**
  - 6 browser contexts (Host + 5 players), all starting at `/`
  - Host: navigates to `/games/create`, enters handle, sets `roundsToWin: 5`, `maxPlayers: 6`, leaves packs/rules at defaults (Core only) → clicks "Create lobby" → arrives at `/games/$code/lobby` with `playerId` persisted in localStorage
  - 5 other contexts: navigate to `/games/join`, enter the room code (read from host's URL), enter their handles, select "Player" → arrive at `/games/$code/lobby` and appear in host's player list
  - Lobby asserts: 6 players, 0 spectators, presence dots green, Start button enabled
  - Host clicks "Start game" → all 6 contexts auto-navigate to `/games/$code/session`
  - **Loop until `game_over` event** (variable number of rounds; with seeded RNG, the outcome is deterministic):
    1. Identify Czar from `round_started` event payload (first round czar = seeded random; subsequent rounds rotate by join order)
    2. Czar context: asserts "Waiting for players…" hero
    3. 5 non-Czar contexts: each selects N cards from hand (N = prompt's `pick`), clicks Submit
    4. Czar context: sees "Start reveal →" button, clicks it
    5. All contexts: assert cards flip in sequence (`REVEAL_STAGGER` apart)
    6. Czar context: clicks the submission marked as winning by the test plan (test plan precomputed from seed) → asserts winner badge appears
    7. All contexts: scoreboard updates; hands replenish to 10 for submitters via `round_end` event
    8. Wait `WINNER_PAUSE` ms → next round starts
    9. Break loop when any context observes `game_over` event
  - Assert: total round count ≤ 20 (sanity bound), winner has exactly 5 points
  - All 6 contexts auto-navigate to `/games/$code/end`
  - End screen asserts: winner callout shows correct handle, final scoreboard matches the running tally tracked by the test
  - **`localStorage.cab_session` persists during end screen**; clicking "Go home" clears it.
  - Test uses the seeded RNG (`CAB_RNG_SEED=test-seed-2026`) so the entire game (Czar order, prompts, Rando picks if enabled) is deterministic.

### Reconnect flows

- [ ] Player refreshes mid-picking → reconnects, hand restored, can still submit
- [ ] Czar refreshes during reveal → reconnects, can still pick winner
- [ ] Player disconnects and reconnects within 30s grace window → no state loss
- [ ] Player disconnects > 30s → removed from game, others continue
- [ ] Czar disconnects > 30s during judging → server auto-picks random winner

### Multi-blank flows

- [ ] Pick-2 black card: player selects 2 cards in order, badges shown
- [ ] Pick-3 black card: player selects 3 cards in order
- [ ] Czar sees all fills flattened in grid with player badges
- [ ] Czar cannot identify who submitted what from order

### Mid-game join

- [ ] Join lobby while game in progress → see "joining after round" state
- [ ] Round ends → new player gets dealt cards, auto-navigates to session
- [ ] New player scoreboard appears for all existing players
- [ ] New player sits out one round before entering Czar rotation

### House rules

- [ ] Rebooting the Universe: spend point, redraw hand (and rejected if score < 1)
- [ ] Packing Heat: on pick-2 cards, hand has 11 cards
- [ ] Rando Cardrissian: auto-submission appears in grid, can win, triggers shame variant
- [ ] God Is Dead: voting UI instead of Czar pick; can't vote self; tie re-vote
- [ ] Survival of the Fittest: takedown turns eliminate cards until one remains
- [ ] Serious Business: Czar ranks top 3 (3/2/1 points), running tally to game end
- [ ] Never Have I Ever: discard cards with confession (max 3 per game)
- [ ] Happy Ending: host can end mid-game with haiku final round (last round wins regardless)

### Base mechanics

- [ ] Gambling: player wagers 1 point → plays second submission. Wins keep point; losses transfer to round winner
- [ ] Submission order on pick-2: cards read in the order submitted (drag handle / numbered selection in hand dock)

### Game end

- [ ] First player to N points triggers `game_over`
- [ ] End screen shows correct winner and final scores
- [ ] Play again creates new lobby with same settings
- [ ] Rando wins → `game_over.mode === "rando_won"` → end screen shows shame variant

### Mobile (viewport 375×667 + 414×896)

- [ ] Home page renders without overflow
- [ ] Lobby code card stacks below title
- [ ] Hand dock scrolls horizontally with snap
- [ ] Scoreboard scrolls horizontally
- [ ] Submissions grid is 2-column
- [ ] Create game form is single-column with stacked summary

### Accessibility

- [ ] All interactive elements reachable via Tab
- [ ] Segmented controls navigable via arrow keys
- [ ] Live region announces "You submitted", "Winner picked"
- [ ] Color contrast meets WCAG AA (auto-pass for B&W design)

### Infrastructure

- `playwright.config.ts`: `globalSetup` seeds the test DB with the **full CAH Base Set** (~90 black cards + ~460 white cards) via the normal seeding pipeline — same code path as production. Tests run against this real data.
- **RNG seeding**: tests set `CAB_RNG_SEED=test-seed-2026` env var; server uses this to seed `crypto.randomInt`-replacement for first-Czar selection, deck shuffles, and Rando's card picks. Same seed → same outcomes → reproducible tests.
- `globalTeardown` truncates test tables and flushes Redis test DB index.
- Tests run against real WS server + real Postgres (test DB) + real Redis (test DB index)
- Separate test DB and Redis DB index from dev (`POSTGRES_DB=cab_test`, `REDIS_DB=1`)
- Tests import timing constants from `src/lib/timing.ts` for deterministic waits

---

## Docker Compose / Deployment — ✅ DONE

### Services

```yaml
services:
  app: # TanStack Start (Node, port 3000) — built from local Dockerfile
  postgres: # postgres:16-alpine, named volume, healthcheck
  redis: # valkey/valkey:8-alpine (pinned major), AOF enabled, named volume, healthcheck
```

Cloudflare Tunnel runs **outside** the Compose stack — user manages it independently on the host. The app container exposes port 3000 to the host; `cloudflared` on the host (systemd unit or separate container) accesses the app at `http://localhost:3000`.

### Dockerfile (multi-stage)

- `build` stage: `node:22-alpine` + pnpm, runs `pnpm install --frozen-lockfile` + `pnpm build`
- `run` stage: `node:22-alpine`, copies `.output/`, runs `node .output/server/index.mjs`, `USER node`, `EXPOSE 3000`

### Environment variables

| Var                        | Purpose                                                          |
| -------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`             | Postgres connection string                                       |
| `REDIS_URL`                | Redis/Valkey connection string                                   |
| `SESSION_SECRET`           | HMAC secret for sessionToken                                     |
| `PORT`                     | App port (default 3000)                                          |
| `NODE_ENV`                 | `development` \| `production`                                    |
| `AXIOM_TOKEN`              | API token for Axiom log shipping (prod only)                     |
| `AXIOM_DATASET`            | Axiom dataset name (default `cab-prod`)                          |
| `POSTHOG_API_KEY`          | PostHog project API key (public; used by both client and server) |
| `POSTHOG_HOST`             | PostHog host (default `https://us.i.posthog.com`)                |
| `POSTHOG_PERSONAL_API_KEY` | PostHog personal API key (build-time only, for sourcemap upload) |
| `CAB_RNG_SEED`             | Seedable PRNG seed (tests only; unset in prod = crypto-seeded)   |

### Notes

- App port binding: default `ports: ["3000:3000"]` in compose exposes the app to the host's network interface — **firewall the port or bind to loopback only (`127.0.0.1:3000:3000`)** to avoid public exposure. With Cloudflare Tunnel running on the host, `127.0.0.1:3000:3000` is the safer choice; otherwise the app is reachable on the host's public IP.
- Cloudflare Tunnel natively proxies WebSocket upgrades — no special config needed on the app side.
- A single `docker-compose.yml` is used for dev and prod; production settings (`restart: unless-stopped`, memory limits — app: 512M, postgres: 1G, redis: 256M — and `NODE_ENV=production`) are applied via environment overrides rather than a separate `docker-compose.prod.yml`
- Health checks: postgres `pg_isready`, redis `redis-cli ping`, app `GET /healthz` (returns 200 with `{ db, redis, activeGames, uptime }` or 503 if any dependency is down)
- Volumes: `postgres_data`, `redis_data` (both backed up via host volume mount)
- **DB schema management:** `pnpm db:push` for both dev and prod (no generated migrations). Acceptable risk for an MVP party game where data loss isn't catastrophic and the schema is rarely modified. Always review the diff plan before confirming a push.

---

## Logging — ✅ DONE

Structured JSON logs via [`pino`](https://github.com/pinojs/pino):

- **Development:** pretty-printed to stdout via `pino-pretty` (human-readable)
- **Production:** JSON stdout, shipped to [Axiom](https://axiom.co/) using the official `@axiomhq/pino` transport. Env vars: `AXIOM_TOKEN`, `AXIOM_DATASET`. Free tier (500GB ingest/mo) easily covers expected volume.

Loggers (named) per module: `cab.ws`, `cab.api`, `cab.engine`, `cab.seed`, `cab.sweeper`. Log levels: `trace` (per-message WS spam, dev only), `debug` (state transitions), `info` (game lifecycle: created/started/ended), `warn` (recoverable issues like seed retries), `error` (5xx, unhandled exceptions).

Every log line carries `{ roomCode?, playerId? }` when applicable for filtering.

---

## Product Analytics, Session Replay & Error Tracking (PostHog) — ⚠️ PARTIAL (SDKs wired, key delivery done; full event taxonomy not yet audited/implemented)

Single PostHog Cloud project (`app.posthog.com`). Three features enabled:

1. **Product analytics** — event-based behaviour tracking
2. **Session replay** — full session recordings with privacy masking
3. **Error tracking** — client and server exception capture

### SDKs

- **Client:** [`posthog-js`](https://posthog.com/docs/libraries/js) initialised in `src/lib/posthog-client.ts` (loaded in `__root.tsx`)
- **Server:** [`posthog-node`](https://posthog.com/docs/libraries/node) initialised in `src/lib/posthog-server.ts`, used by API routes, WS handler, and game-event-handler for server-side events

### User identification

No accounts → use an anonymous distinct ID:

- On first page mount, generate a stable browser-scoped UUID stored in `localStorage.cab_anon_id`. This becomes the PostHog `distinct_id`.
- On joining or creating a game, the client sends `anonId` in the HTTP request body (`POST /api/games` and `POST /api/games/$code/join`). Server persists it on `game_players.posthog_anon_id` and uses it as `distinct_id` for all server-side PostHog events for that player.
- On joining a game, the client calls `posthog.identify(anonId, { username, currentRoom: roomCode })` to attach the handle (still anonymous — note: a self-chosen handle could technically contain PII if a user types their real name).
- `anonId` is also added to `CabSession` and survives across reconnects.

### Privacy / masking

- **Session replay:** Use PostHog's `maskAllInputs: true` (camelCase per JS SDK), but explicitly mask card content via `data-ph-no-capture` attribute on `.card-text` and `.card-back-mark` elements. Cards Against Humanity content is often crude — never recorded.
- Hand cards, prompts in transit, and submission contents are all `data-ph-no-capture`.
- Only UI shell (buttons, layout, animations) is captured for replay.

### Configuration & key delivery

The PostHog key reaches the client via the `GET /api/config` endpoint (not bundled into Vite's client build). On app mount, the client fetches `{ posthogKey, posthogHost }` and initialises `posthog-js`. This avoids exposing the key as a `VITE_*` env var (which would bake it into the static bundle and require rebuilds on key rotation).

```ts
// src/lib/posthog-client.ts
// Called from __root.tsx after fetching GET /api/config
export async function initPostHog() {
  const cfg = await fetch('/api/config').then((r) => r.json())
  posthog.init(cfg.posthogKey, {
    api_host: cfg.posthogHost,
    person_profiles: 'identified_only', // don't create profiles for anonymous pageviews
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-ph-no-capture], .card-text, .card-back-mark',
      recordCanvas: false,
    },
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false, // we use explicit posthog.capture() for every event
    loaded: (ph) => {
      if (location.hostname === 'localhost') ph.opt_out_capturing()
    },
  })
}
```

### Event taxonomy

All events use snake*case names with `cab*` prefix to namespace them in PostHog.

**Onboarding / navigation (client-side):**

Route visits are captured automatically via PostHog's `$pageview` (with `capture_pageview: true`) — no need for `cab_*_viewed` events. Button clicks use explicit events:

| Event                | Properties | When                   |
| -------------------- | ---------- | ---------------------- |
| `cab_create_clicked` | —          | "Create a game" button |
| `cab_join_clicked`   | —          | "Join a game" button   |
| `cab_stats_clicked`  | —          | "See the stats" button |

**Lobby (mixed client + server):**
| Event | Properties | Side | When |
|---|---|---|---|
| `cab_game_created` | `roomCode, maxPlayers, roundsToWin, timer, packs[], rules[], modalRule` | server | `POST /api/games` succeeds |
| `cab_game_joined` | `roomCode, role, isMidGame` | server | `POST /api/games/$code/join` succeeds |
| `cab_room_code_copied` | `roomCode, format: "code"\|"link"` | client | Copy button clicked |
| `cab_game_started` | `roomCode, playerCount, spectatorCount, durationLobbyMs` | server | Host starts game |

**Gameplay (server-side, fan-out via roomCode):**
| Event | Properties | When |
|---|---|---|
| `cab_round_started` | `roomCode, round, czarId, blackCardPick, mode` | round_started emitted |
| `cab_card_played` | `roomCode, round, playerId, pickCount` | `play` event received |
| `cab_gambled` | `roomCode, round, playerId` | `gamble` event received |
| `cab_winner_picked` | `roomCode, round, winnerId, isRando, judgmentDurationMs` | `pick` resolves |
| `cab_round_voted` | `roomCode, round, winnerId, voteSpread` | God Is Dead resolution |
| `cab_round_eliminated` | `roomCode, round, winnerId, totalEliminations` | Survival resolution |
| `cab_round_ranked` | `roomCode, round, top3: [{playerId, points}]` | Serious Business resolution |
| `cab_player_skipped` | `roomCode, round, playerId` | Timer expired |
| `cab_rule_triggered` | `roomCode, round, playerId, rule: RuleId` | Player redraws / discards / etc. |

**Connection lifecycle (client + server):**
| Event | Properties | Side | When |
|---|---|---|---|
| `cab_ws_connected` | `roomCode, reconnect: boolean` | client | WS open |
| `cab_ws_disconnected` | `roomCode, reason, durationConnectedMs` | client | WS close |
| `cab_reconnect_attempt` | `roomCode, attempt, backoffMs` | client | Each retry |
| `cab_player_dropped` | `roomCode, playerId, reason` | server | Grace expired or explicit leave |

**End of game:**
| Event | Properties | When |
|---|---|---|
| `cab_game_ended` | `roomCode, mode: GameOverMode, winnerId, totalRounds, durationMs, finalScores[]` | `game_over` emitted (note: `winnerIsRando` dropped — derivable from `mode === "rando_won"`) |
| `cab_play_again_clicked` | `previousRoomCode` | End screen "Play again" button |
| `cab_go_home_clicked` | `previousRoomCode` | End screen "Go home" button |

### Error tracking

- **Client errors:** `posthog.captureException(err)` invoked from a React error boundary in `__root.tsx`, and from a global `window.addEventListener('unhandledrejection')` handler.
- **Server errors:** `posthogServer.captureException(err, { distinct_id, properties })` invoked in:
  - h3 error middleware (catches all unhandled exceptions from HTTP routes)
  - WS handler's outer try/catch
  - `game-event-handler.ts` error path
- Stack traces are sent in full (no source-map stripping). PostHog handles sourcemap upload via `posthog-cli` in the production Dockerfile.

### Environment variables

| Var                        | Purpose                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTHOG_API_KEY`          | Project API key (server-side env). Server reads it and exposes it to the client only via `GET /api/config`. Not bundled into the Vite client build. |
| `POSTHOG_HOST`             | `https://us.i.posthog.com` (default) or EU equivalent. Same delivery model as the API key.                                                          |
| `POSTHOG_PERSONAL_API_KEY` | Server-only; used for sourcemap upload during `pnpm build` (via `posthog-cli`). Never sent to clients.                                              |

A single `POSTHOG_API_KEY` env var on the server is the single source of truth. The client fetches it at runtime via `/api/config` — rotation is just an env var update + container restart, no rebuild required.

### Local dev

PostHog client auto-opts-out on `localhost` to keep dev events out of the prod project. To enable dev tracking, set `POSTHOG_API_KEY` to a separate "dev" project key and remove the localhost opt-out.

---

## Quick Reference

| Command                                    | Purpose                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| `pnpm install`                             | Install dependencies                                 |
| `pnpm dev`                                 | Start dev server with HMR (http://localhost:3000)    |
| `pnpm build`                               | Production build to `.output/`                       |
| `pnpm start`                               | Run the production build locally                     |
| `pnpm db:push`                             | Apply Drizzle schema to Postgres (no migrations)     |
| `pnpm db:studio`                           | Open Drizzle Studio (DB browser)                     |
| `pnpm seed`                                | Manually trigger card pack seeding from REST AH      |
| `pnpm typecheck`                           | Run TypeScript type check                            |
| `pnpm lint`                                | Run ESLint                                           |
| `pnpm test:e2e`                            | Run Playwright E2E suite (requires Postgres + Redis) |
| `pnpm test:e2e:ui`                         | Playwright UI mode for debugging                     |
| `docker compose up -d`                     | Start full stack locally                             |
| `docker compose up -d postgres redis`      | Just deps for local dev                              |
| `NODE_ENV=production docker compose up -d` | Production deploy (single compose file)              |

---

## Project File Structure

```
src/
  routes/
    __root.tsx
    index.tsx
    stats.tsx
    games/
      create.tsx
      join.tsx
      $code/
        lobby.tsx
        session.tsx
        end.tsx
    api/
      healthz.ts
      games/
        index.ts            — POST create game
        $code/
          join.ts
          start.ts
          ws.ts             — h3 WebSocket route
  components/
    ui/
      Card.tsx              — PromptCard, ResponseCard, CardBack
      Button.tsx
      Avatar.tsx
      Stepper.tsx
      SegmentedControl.tsx
      CheckCard.tsx
      Sheet.tsx
      Topbar.tsx
    game/
      Scoreboard.tsx
      HandDock.tsx
      SubmissionsGrid.tsx
      PromptStage.tsx
      ReconnectOverlay.tsx
  contexts/
    GameContext.tsx
  hooks/
    useGameSocket.ts        — stub for frontend-first phase
    useSession.ts           — reads/writes cab_session localStorage
  lib/
    timing.ts               — animation timing constants
    rng.ts                  — seedable PRNG wrapper (seedrandom)
    game-engine.ts          — round logic, house rules, deck ops
    game-state.ts           — Redis state operations
    game-event-handler.ts   — orchestrates game start, round transitions
    seed.ts                 — card data seeding from REST AH
    sweeper.ts              — stale-game cleanup background job
    session-token.ts        — HMAC sign/verify
    code-gen.ts             — room code generation (uses crypto.randomInt)
    rate-limit.ts           — per-IP Redis sliding window
    logger.ts               — pino instance + named child loggers
    posthog-client.ts       — posthog-js init + capture helpers
    posthog-server.ts       — posthog-node init + server-side capture
    types.ts
  ws/
    handler.ts              — h3 WebSocket server handler
    auth.ts                 — sessionToken validation
  db/
    schema.ts               — Drizzle schema
    index.ts                — db singleton
  styles.css                — Tailwind v4 @theme + design tokens + game CSS
tests/
  e2e/
    create-join-play.spec.ts
    full-game.spec.ts        — 6-player 5-win golden-path test
    reconnect.spec.ts
    mid-game-join.spec.ts
    house-rules.spec.ts
    multi-blank.spec.ts
    mobile.spec.ts
    a11y.spec.ts
  fixtures/
    handles.ts               — test player handles
    expected-outcomes.ts     — pre-computed game outcomes for seeded RNG
  playwright.config.ts
docs/
  superpowers/specs/        — this spec
  design-reference/         — original Claude Design bundle
Dockerfile
docker-compose.yml
.env.example
```
