# Cards Against Bhayanak — Design Spec
_2026-05-12_

## Overview

A real-time multiplayer card game in the Cards Against Humanity genre. Players join via a 6-character room code (Jackbox-style — no accounts, no login). One rotating Card Czar reads a black prompt card; everyone else submits white response cards; the funniest answer wins an Awesome Point. First to N points wins.

---

## Tech Stack

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

## Authentication & Session Lifecycle

**Session-only (Jackbox-style).** No user accounts, no passwords.

### Join flow (HTTP first, then WebSocket)

1. **HTTP `POST /api/games/$code/join`** — body `{ username, role: "player"|"spectator" }`. Server:
   - Validates room exists, has capacity
   - Generates `playerId` (cuid or postgres-generated)
   - Inserts row in `game_players` (status: `active` | `queued` | `spectator`)
   - Returns `{ playerId, sessionToken, status, gamePhase }`
2. **Client writes `localStorage.cab_session`** = `{ roomCode, playerId, sessionToken, username, role }`
3. **WebSocket connects** to `/api/games/$code/ws` and immediately sends `{ type: "auth", sessionToken }` to register the socket against the existing player
4. **Server validates `sessionToken`**, binds socket → player

`sessionToken` = HMAC-signed `{ playerId, roomCode, issuedAt }`. Verified server-side without DB lookup. Expires when room expires (24h Redis TTL).

### Reconnect flow

On any page mount:
1. Read `localStorage.cab_session`. If missing → no active game.
2. If present and current URL doesn't match active game → redirect to `/games/$code/session` (or `/lobby` if status is `lobby`).
3. Open WebSocket, send `{ type: "auth", sessionToken }`.
4. Send `{ type: "rejoin" }`. Server responds with `state_snapshot`.
5. Show `Reconnecting…` overlay until snapshot received.
6. **Grace window: 30s.** Server keeps player active in `game:{code}:players` for 30s after disconnect. After that, treated as dropped (other players notified, hand returned to deck).

### Logout / leave

Client clears `cab_session` after `game_over` event, or on explicit Leave button. Server removes player from Redis on `leave` message.

---

## Routes

| Path | Screen |
|---|---|
| `/` | Home |
| `/stats` | Stats (public) |
| `/games/create` | Create game |
| `/games/join` | Join game |
| `/games/$code/lobby` | Lobby (pre-game + mid-game waiting) |
| `/games/$code/session` | Game session |
| `/games/$code/end` | End screen / final scoreboard |

### Inter-route transitions

- `/games/create` → `POST /api/games` (create room) → redirect to `/games/$code/lobby`
- `/games/join` → `POST /api/games/$code/join` → redirect to `/games/$code/lobby`
- Host clicks "Start game" → `POST /api/games/$code/start` → server emits `game_started` over WS → **all lobby clients navigate to `/games/$code/session`**
- On `game_over` event → all session clients navigate to `/games/$code/end`
- Late joiner in lobby receives `round_end` with their playerId in `activatedPlayers[]` → client navigates to `/games/$code/session`

---

## Visual Design System

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
| Class | Width |
|---|---|
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
  DEAL_MS:         550,   // card dealing animation
  FADE_IN_MS:      400,   // scene fade-in
  REVEAL_STAGGER:  700,   // ms between sequential card reveals
  WINNER_PAUSE:   2600,   // post-winner-picked, before next round
  RECONNECT_TOAST: 250,   // debounce for "Reconnecting…" overlay
  GRACE_WINDOW_MS: 30000, // server-side disconnect grace (DB constant)
} as const
```

E2E tests import these to time their assertions deterministically.

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

## Screens

### 1. Home (`/`)
- Large display headline: "A horrible card game for *horrible* friends."
- Hero card stack (1 prompt card + 2 response cards, rotated/fanned)
- CTAs: Create a game (primary), Join a game (ghost), See the stats (ghost)
- Scrolling marquee strip at bottom

### 2. Create Game (`/games/create`)
- Handle input (username, 2–20 chars)
- Steppers: Max players (3–10), Rounds to win (3–20)
- Segmented: Round timer (30s / 60s / 90s / Off)
- Card packs grid (Core locked, others toggleable) — loaded from DB
- House rules grid (all toggleable)
- Sticky right panel: live summary + "Create lobby" button (disabled until handle ≥2 chars)

### 3. Join Game (`/games/join`)
- Room code input (uppercase, monospace, 6 chars)
- Handle input
- Join-as picker: Player / Spectator (auto-forced to Spectator if room is full)
- If room full: banner explains spectator-only

### 4. Lobby (`/games/$code/lobby`)
Two states:

**Pre-game:** Room code card (large, copy button), player list with HOST/YOU/READY badges, empty seats (dashed), spectator row, game summary panel (packs, rules, settings), host sees "Start game" (disabled until ≥3 players), non-host sees "Waiting for host…" spinner.

**Mid-game waiting:** Same layout but shows "Game in progress — you'll join after this round." Live scoreboard visible (read-only). On `round_end` event containing this player's ID in `activatedPlayers[]`, the client navigates to `/games/$code/session`.

### 5. Game Session (`/games/$code/session`)
**Phases:**

| Phase | Player view | Czar view |
|---|---|---|
| `picking` | Prompt card hero (centered), hand dock at bottom, submit button | Prompt hero, "Waiting for players…" spinner |
| `waiting` | Prompt hero, submission progress pips, "Waiting on others…" | Same |
| `judging` | Face-down card grid, "Judge is reading" note | Face-down grid, "Start reveal →" button |
| `reveal` | Cards flip one-by-one, winner highlighted | Click revealed card to pick winner |
| `transition` | Winner badge + +1 point, server-controlled pause, then next round | Same |

**Phase timing is server-controlled.** The server schedules transitions (`reveal_start`, `card_revealed`, `round_end`, `round_started`) and emits events at the right time. Clients only animate based on received events — they do not run their own phase timers. This prevents drift across clients.

**Layout:**
- Sticky topbar: ROUND XX pill, timer pill, Leave button
- Scoreboard row (current Czar highlighted in white chip)
- Stage: prompt card left (xl size), submissions grid right
- Hand dock: sticky bottom, 7 cards fanned, selected cards lift

**Multi-blank cards:** Black cards with `pick: 2` or `pick: 3` require multiple white card selections. Cards flatten into the grid with player-number badges.

### 6. Stats (`/stats`)
- Headline tiles: games played, rounds judged, cards submitted, avg players, avg spectators, avg session
- Sparkline: games per day (30d)
- Bar chart: lobbies by player count
- Rando Cardrissian win stats
- Horizontal bar charts: pack adoption %, house rules adoption %
- Top 5 most-picked response cards leaderboard

**Empty state.** Fresh deployment with zero games shows: "No games played yet. Come back after some chaos." All charts hidden until ≥1 game completes.

**Data source.** Aggregated from Postgres (not Redis — Redis state is ephemeral). Computed by a server function at request time, cached for 5 minutes via `Cache-Control` header. Frontend-first phase: mocked from `STATS_DATA` constant matching the design's shape.

### 7. End Game (`/games/$code/end`)
- Final scoreboard with winner callout
- "Play again" (creates new lobby with same settings) and "Go home" buttons

---

## State Management

### `GameContext` (pre-game draft — survives Create → Lobby navigation)
```ts
type GameDraft = {
  username: string
  maxPlayers: number        // 3–10, default 6
  roundsToWin: number       // 3–20, default 7
  timer: "30s"|"60s"|"90s"|"Off"
  packs: string[]           // pack IDs
  rules: string[]           // house rule IDs
  roomCode?: string
  playerId?: string
  role?: "player"|"spectator"
}
```

### Session persistence (`localStorage`)
Key `cab_session`: `{ roomCode, playerId, sessionToken, role, username }`. Set on join/create, cleared on game end. Read on app init to redirect back to active game.

### Game session state (local to `/games/$code/session`)
```ts
type GamePhase =
  | "picking"        // players submitting cards
  | "waiting"        // you've submitted, waiting on others
  | "judging"        // czar choosing (or all-players voting in God Is Dead)
  | "eliminating"    // Survival of the Fittest takedown rounds
  | "ranking"        // Serious Business top-3 ranking
  | "reveal"         // cards being revealed
  | "transition"     // winner shown, brief pause before next round

type SessionState = {
  phase: GamePhase
  round: number
  prompt: { text: string; pick: number }
  czarId: string
  hand: string[]            // white card texts for this player (server only sends to owner)
  submissions: Submission[] // revealed progressively; server has already shuffled order
  scores: PlayerScore[]
  revealIndex: number
  winnerId: string | null
}
```
Populated from WebSocket events; falls back to snapshot on reconnect.

### Settings immutability

Once `POST /api/games/$code/start` succeeds, game config (packs, rules, roundsToWin, maxPlayers) is frozen. Host cannot modify mid-game. The `game_sessions.config` JSON is the source of truth and is locked at start.

---

## WebSocket Protocol

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
{ type: "swap_hand" }                              // Humanitarianism
{ type: "confess_discard", cardId }                // Never Have I Ever
{ type: "leave" }                                  // explicit leave
{ type: "ping" }                                   // keepalive
```

All client messages are scoped to the socket's authenticated `playerId` + `roomCode` — clients never send these explicitly post-auth, eliminating spoof risk.

### Server → Client events
```
{ type: "auth_ok" }
{ type: "auth_error",     reason }
{ type: "state_snapshot", state: SessionState }     // sent on rejoin
{ type: "player_joined",  player }
{ type: "player_left",    playerId }
{ type: "game_started",   firstRound }
{ type: "round_started",  round, prompt, czarId, hand? }
{ type: "player_played",  playerId }                // face-down ack to others
{ type: "player_gambled", playerId }                // notify others of a wager
{ type: "reveal_start" }
{ type: "card_revealed",  submissionIndex, fills[] }
{ type: "round_won",      winnerId, submissionId, scores[], handsRefilled[] }
{ type: "round_ranked",   ranking[], scoresDelta[] }  // Serious Business
{ type: "elimination_turn", playerId }              // Survival: whose turn to eliminate
{ type: "card_eliminated",  submissionId, byPlayerId } // Survival
{ type: "vote_tally",     votes: {submissionId: count} } // God Is Dead
{ type: "round_end",      activatedPlayers[] }      // mid-game joiners now active
{ type: "game_over",      finalScores[], winnerId, randoWon: boolean, mode: "normal"|"happy_ending" }
{ type: "error",          message }
{ type: "pong" }
```

### Submission shuffling

Before sending submissions to the Czar (or to anyone post-reveal), the server shuffles their order. The `submissionId` is a server-generated opaque ID — clients never see player→submission mapping until reveal. This prevents Czars from identifying who played what by submission order.

### Submission deduplication

If a player sends `play` twice for the same round (network glitch, double-click), the server treats the second as a no-op (responds with same `player_played` ack, doesn't update Redis). Client UI uses optimistic local state to prevent UI confusion.

### Reconnect flow
1. Client connects, sends `auth`, then `rejoin`
2. Server responds with `state_snapshot` — full current SessionState
3. Client hydrates immediately; shows "Reconnecting…" overlay until snapshot arrives (debounced by `RECONNECT_TOAST` ms to avoid flash)
4. Server grace window: `GRACE_WINDOW_MS` before treating disconnect as permanent drop

### Disconnect handling

| Who | What happens |
|---|---|
| Regular player picking | Card pool returns their cards (if any submitted) on permanent drop; round continues with remaining players |
| Regular player judging | No action — they don't have an active role this round |
| **Czar** during `picking`/`waiting` | If permanent drop, round is voided. Cards returned to hands. Next player becomes Czar. Round restarts with same prompt or new (config: `voidedRoundPolicy: "restart"|"skip"`, default `restart`) |
| **Czar** during `judging`/`reveal` | If permanent drop, server auto-picks a random submission as winner after grace window expires |
| Host (anyone) | "Host" flag transfers to next player by join order. Game continues normally. |

### Keepalive

Client sends `ping` every 15s; server responds `pong`. After 45s of silence, server treats client as disconnected (starts grace window).

---

## Game Rules Engine

### Core loop
1. Deal 10 white cards to each active player at game start
2. Each round: rotate Czar, deal new black card from shuffled deck
3. Non-czar players submit `pick` white cards (1, 2, or 3 per black card) — **submission order matters for multi-pick cards** (the Czar reads them in the order submitted)
4. Czar shuffles answers and reads each combination dramatically (re-reading the prompt before each, per official rules)
5. Czar picks winner → winner gets black card as Awesome Point
6. **Hand replenishment:** Immediately after winner picked, before `transition` phase begins, all submitters' hands replenish to 10 (server emits `round_won` with each player's new hand)
7. First to `roundsToWin` Awesome Points wins → `game_over`

### Gambling (base mechanic, always on)

Before submitting their primary card(s) for the round, any non-Czar player with `score >= 1` may **wager 1 Awesome Point** to play an additional `pick` cards (effectively a second submission for the same prompt).

- WS event: `{ type: "gamble" }` — sent before `play`. Server decrements score by 1, deals `pick` extra cards to the player, allows them to submit a second submission.
- Each of the player's submissions is treated independently in the Czar's view (they don't know they belong to the same player until reveal).
- **If any of the player's submissions wins:** they keep their wagered point and gain 1 from winning (net +1, same as normal).
- **If neither wins:** the wagered point transfers to the round winner.
- Gambling is disabled in `God Is Dead` mode (no Czar to read), in `Serious Business` mode (point math gets weird), and on round 1 (no points to wager).

### Czar selection

Players are ordered by `game_players.joined_at` (insertion order). Czar rotates through this array by index, modulo the number of *active* (non-spectator, non-queued) players. New mid-game joiners are appended to the end and join the rotation from the next-next round (they sit out as a regular player for one round before potentially becoming Czar).

Round 1 Czar is the host (index 0).

### Card pool

- At game create: host selects packs. Pack list stored in `game_sessions.config.packs`.
- At game start (`POST /api/games/$code/start`): server materializes shuffled `black_deck` and `white_deck` in Redis from the union of selected packs.
- Pool is frozen at start — adding packs mid-game has no effect.
- Two Redis lists: `game:{code}:deck:black` and `game:{code}:deck:white`.

### Deck exhaustion

- **White cards run low:** When `LLEN game:{code}:deck:white < players * 10`, server shuffles the discard pile (all played non-current-hand white cards) back in.
- **Black cards exhausted:** Game ends naturally — server emits `game_over` with the current leader as winner. Edge note: a fresh setup loading all CAH packs has thousands of black cards; this is practically rare.

### Submission order randomization

When a round transitions to `judging`, the server randomly permutes the submissions array and assigns each a stable `submissionId`. The mapping `submissionId → playerId` is kept server-side only until `reveal`. The Czar's view shows them in the shuffled order; they cannot infer who submitted what.

### House Rules

Official CAH rules from the 2014 rulebook (`https://s3.amazonaws.com/cah/CAH_Rules.pdf`):

| Rule | ID | Source | Implementation |
|---|---|---|---|
| Rebooting the Universe | `rebooting` | Official | Player action: spend 1 point → return any number of white cards, redraw to 10. Available between rounds only. Requires `score >= 1`. |
| Packing Heat | `packing_heat` | Official | On `pick: 2` black card → deal 1 extra white card to each player before submission phase. Hand becomes 11; submitting returns to 10. |
| Rando Cardrissian | `rando` | Official | Auto-submitted random white card each round, attributed to imaginary player "Rando Cardrissian". If Rando wins the game overall, `game_over.randoWon = true` triggers shame screen variant. |
| God Is Dead | `godmode` | Official | No Czar. All players submit, then all players vote. Each player gets one vote, cannot vote for own submission. Most votes wins. **Tie-breaking:** Re-vote between tied submissions. If tie persists 2×, random pick among tied. Disables Gambling and Serious Business. |
| Survival of the Fittest | `survival` | Official | After all submissions are in, players take turns (in join order, skipping Czar) eliminating one submission each. Last submission remaining wins. UI: each player's turn shows a "remove one" prompt with all submissions face-up; clicking eliminates it. |
| Serious Business | `serious_business` | Official | Instead of single winner per round, Czar ranks the **top 3 submissions**. 1st = 3 points, 2nd = 2 points, 3rd = 1 point. Track running tally. Final winner = highest total. Disables Gambling. UI: Czar's reveal screen shows 1/2/3 podium slots; cards dragged or click-numbered into slots. |
| Never Have I Ever | `never_have_i_ever` | Official | Players may discard any white card from their hand at any time (between rounds) with a public confession ("I don't get this one"). Server replaces with a new card. Limited to 3 discards per game to prevent abuse. WS event: `{ type: "confess_discard", cardId }`. |
| Happy Ending | `happy_ending` | Official | Host may end game early. When triggered, the final black card is forced to a "Make a Haiku" card (haikus need not be 5-7-5; just read dramatically per the official rule). Winner of the final round wins regardless of point totals. |
| Haiku Mode | `haiku` | **Design extension** | Decorative — UI shows a 5-7-5 syllable hint near the prompt. No enforcement. Note: not in the official rulebook; included because the design prototype features it. |
| The Comeback | `comeback` | **Design extension** | Player(s) tied for last place play **2× normal cards**. For pick-N black cards, last-place plays 2N cards as one submission with 2N fills. Czar sees as one entry. Not in the official rulebook; included because the design prototype features it. |
| Humanitarianism | `humanitarianism` | **Design extension** | Once per round per player: swap entire hand. Triggered via `swap_hand` event. (We added this from CAH community variants; not in the official rulebook.) |

---

## Spectator Permissions

| Phase | Spectator can see | Spectator cannot see |
|---|---|---|
| Lobby | Player list, room code, settings | (everything visible) |
| `picking` | Prompt, who has submitted (face-down count) | Anyone's hand, anyone's submitted card |
| `waiting` | Prompt, submission progress | Submitted card content |
| `judging` | Prompt, face-down submissions | Card content |
| `reveal` | Prompt, revealed cards, winner | (parity with players) |
| `transition` / `round_end` | New scores, winner | — |
| `game_over` | Final scoreboard | — |

Spectators can chat (if chat is implemented later) but cannot send game actions (`play`, `pick`, `vote`, `redraw`, `swap_hand`). Server rejects these events with `error` if sent by a spectator.

---

## Mid-Game Join

1. Player joins via `/games/join` while game is in progress
2. Server adds them to `game:{code}:players` with status `queued`, returns `playerId`
3. Client navigates to `/games/$code/lobby` (in mid-game-waiting state)
4. Server emits `player_joined` to all clients
5. On `round_end`, server moves all `queued` players to `active`, deals each a starting hand of 10, emits `round_end` with `activatedPlayers[]`
6. Each newly-activated client receives the event, sees their own `playerId` in `activatedPlayers[]`, navigates to `/games/$code/session`
7. New player enters Czar rotation 2 rounds later (one round as regular player first — see Czar selection)

---

## Card Data Seeding

### When
On server start in `src/lib/seed.ts`. Runs asynchronously — does not block server boot. Server is operational immediately; gameplay routes return 503 until seed completes if DB has zero packs.

### What
1. `GET https://restagainsthumanity.com/api/v2/packs` — list of pack names
2. For each pack (sequential, ~50 packs): `GET /cards?packs=<name>&includePackNames=true`
3. Normalise black card text: replace `_` with `__________` (10 underscores) to match render conventions
4. Upsert into `packs`, `black_cards`, `white_cards` (idempotent via `ON CONFLICT DO NOTHING` on natural keys: `packs.slug`, `(pack_id, text)` for cards)
5. Log: `Seeded N packs, M black cards, K white cards in T seconds`

### Resilience
- Retry with exponential backoff (1s, 2s, 4s, max 30s) on transient errors
- If REST AH API is completely down at startup, log warning and continue with whatever's in the DB — gameplay works with cached packs
- If DB is empty AND API is down, gameplay routes return 503 "No card data available" until seeding succeeds (background retry every 5 min)

---

## Database Schema (Drizzle)

```
packs          — id, name, slug (unique), card_count, created_at
black_cards    — id, pack_id (fk), text, pick (1|2|3),  unique(pack_id, text)
white_cards    — id, pack_id (fk), text,                unique(pack_id, text)
game_sessions  — id, code (6-char, unique), status, config JSONB, host_player_id, created_at, ended_at, winner_player_id
game_players   — id, session_id (fk), username, role, score, status (active|queued|spectator|disconnected), joined_at, is_host
game_rounds    — id, session_id (fk), round_num, black_card_id, czar_player_id, winner_player_id, winning_submission_fills JSONB, played_at
```

### Aggregations for Stats

Materialized views or query-time aggregations:
- `games_played_count` — `count(*) from game_sessions where status='ended'`
- `rounds_count` — `count(*) from game_rounds`
- `avg_players_per_game` — `avg(count(game_players)) per game_session`
- `pack_adoption` — `count(distinct session_id) per pack` from `config.packs` JSONB
- `top_response_cards` — `count(*) of winning_submission_fills entries`
- `rando_wins` — `count(*) from game_sessions where winner.username='rando'`

---

## Redis State Shape (per room)

```
game:{code}             hash: status, currentRound, totalRounds, czarIndex, hostId, config JSON
game:{code}:players     hash: playerId → GamePlayer JSON
game:{code}:round       hash: blackCardId, czarId, submissions JSON, winnerId
game:{code}:deck:black  list of card IDs (shuffled)
game:{code}:deck:white  list of card IDs (shuffled)
game:{code}:discard:white  list (for reshuffle when deck low)
game:{code}:hand:{id}   set of white card IDs
game:{code}:grace:{id}  string with PX expiry = GRACE_WINDOW_MS; set on disconnect
game:{code}:channel     pub/sub channel
```
All keys: 24h TTL on idle. Refreshed on any state mutation.

### Persistence

Valkey configured with AOF (`appendonly yes`) so a container restart recovers state up to the last write. RDB snapshots every 5 min as a backup. Volume mounted at `/data`.

---

## Room Code Generation

- 6 alphanumeric chars, uppercase, excluding ambiguous: `O`, `0`, `I`, `1`, `L` → alphabet = `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 chars)
- Total space: `31^6 ≈ 887M` — plenty.
- Generation: `crypto.randomBytes(6).map(b => ALPHABET[b % 31])`
- Collision check: `SET game:{code} ... NX EX 86400`. If `NX` fails, regenerate. Retry up to 5 times.
- Display format: `XXX-XXX` (dash inserted client-side only).

---

## E2E Testing (Playwright)

Test matrix using multi-context (separate browser contexts per player):

### Core flows
- [ ] Create game → lobby → start → full round → winner declared → next round begins
- [ ] Join as player → play through a round
- [ ] Join as spectator → cannot submit cards, sees all reveals
- [ ] Room full → auto-spectate on join
- [ ] Host leaves → host role transfers, game continues

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
- [ ] Humanitarianism: swap entire hand once per round
- [ ] The Comeback: last-place player submits 2 cards (4 for pick-2 black)
- [ ] Happy Ending: host can end mid-game with haiku final round (last round wins regardless)

### Base mechanics
- [ ] Gambling: player wagers 1 point → plays second submission. Wins keep point; losses transfer to round winner
- [ ] Submission order on pick-2: cards read in the order submitted (drag handle / numbered selection in hand dock)

### Game end
- [ ] First player to N points triggers `game_over`
- [ ] End screen shows correct winner and final scores
- [ ] Play again creates new lobby with same settings
- [ ] Rando wins → shame variant of end screen

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
- `playwright.config.ts`: `globalSetup` seeds test DB with **a deterministic test pack** (10 black + 30 white cards with predictable text — defined in `tests/fixtures/test-pack.ts`) so prompts and outcomes are reproducible. `globalTeardown` cleans up.
- Tests run against real WS server + real Postgres (test DB) + real Redis (test DB index)
- Separate test DB and Redis DB index from dev (`POSTGRES_DB=cab_test`, `REDIS_DB=1`)
- Tests import timing constants from `src/lib/timing.ts` for deterministic waits

---

## Docker Compose / Deployment

### Services
```yaml
services:
  app:      # TanStack Start (Node, port 3000) — built from local Dockerfile
  postgres: # postgres:16-alpine, named volume, healthcheck
  redis:    # valkey/valkey:latest, AOF enabled, named volume, healthcheck
  cloudflared: # cloudflare/cloudflared:latest, TUNNEL_TOKEN from env
```

### Dockerfile (multi-stage)
- `build` stage: `node:22-alpine` + pnpm, runs `pnpm install --frozen-lockfile` + `pnpm build`
- `run` stage: `node:22-alpine`, copies `.output/`, runs `node .output/server/index.mjs`, `USER node`, `EXPOSE 3000`

### Environment variables
`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `PORT` (default 3000), `TUNNEL_TOKEN`, `NODE_ENV`

### Notes
- App port not exposed to host (only to Docker network) — Cloudflare Tunnel forwards `yourdomain.com` → `http://app:3000`
- Tunnel natively proxies WebSocket upgrades — no extra config needed
- `docker-compose.prod.yml` override: `restart: unless-stopped`, memory limits (app: 512M, postgres: 1G, redis: 256M), `NODE_ENV=production`
- Health checks: postgres `pg_isready`, redis `redis-cli ping`, app `GET /healthz`
- Volumes: `postgres_data`, `redis_data` (both backed up via host volume mount)

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
    game-engine.ts          — round logic, house rules, deck ops
    game-state.ts           — Redis state operations
    game-event-handler.ts   — orchestrates game start, round transitions
    seed.ts                 — card data seeding from REST AH
    session-token.ts        — HMAC sign/verify
    code-gen.ts             — room code generation
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
    reconnect.spec.ts
    mid-game-join.spec.ts
    house-rules.spec.ts
    multi-blank.spec.ts
    mobile.spec.ts
    a11y.spec.ts
  fixtures/
    test-pack.ts            — deterministic test card data
  playwright.config.ts
docs/
  superpowers/specs/        — this spec
  design-reference/         — original Claude Design bundle
Dockerfile
docker-compose.yml
docker-compose.prod.yml
.env.example
```
