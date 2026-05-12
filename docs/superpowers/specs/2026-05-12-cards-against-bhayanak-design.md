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

---

## Authentication

**Session-only (Jackbox-style).** No user accounts, no passwords.

- Players pick a handle (username) on the Create or Join screen
- On game join, the server issues a short-lived session token stored in `localStorage`: `{ roomCode, username, playerId, role: "player"|"spectator" }`
- On refresh, the client reads localStorage and redirects to the correct active route
- Sessions expire when the game ends or after 24h Redis TTL

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

**Mid-game waiting:** Same layout but shows "Game in progress — you'll join after this round." Live scoreboard visible (read-only). Server emits `round_end` to activate queued players.

### 5. Game Session (`/games/$code/session`)
**Phases:**

| Phase | Player view | Czar view |
|---|---|---|
| `picking` | Prompt card hero (centered), hand dock at bottom, submit button | Prompt hero, "Waiting for players…" spinner |
| `waiting` | Prompt hero, submission progress pips, "Waiting on others…" | Same |
| `judging` | Face-down card grid, "Judge is reading" note | Face-down grid, "Start reveal →" button |
| `reveal` | Cards flip one-by-one, winner highlighted | Click revealed card to pick winner |
| `transition` | Winner badge + +1 point, 2.6s pause, then next round | Same |

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
Key `cab_session`: `{ roomCode, playerId, role, username }`. Set on join/create, cleared on game end. Read on app init to redirect back to active game.

### Game session state (local to `/games/$code/session`)
```ts
type GamePhase = "picking"|"waiting"|"judging"|"reveal"|"transition"

type SessionState = {
  phase: GamePhase
  round: number
  prompt: { text: string; pick: number }
  czarId: string
  hand: string[]            // white card texts for this player
  submissions: Submission[] // revealed progressively
  scores: PlayerScore[]
  revealIndex: number
  winnerId: string | null
}
```
Populated from WebSocket events; falls back to snapshot on reconnect.

---

## WebSocket Protocol

### Connection
`ws://<host>/api/games/<code>/ws`

### Client → Server events
```
{ type: "join",    roomCode, playerId, username, role }
{ type: "rejoin",  roomCode, playerId }           // on reconnect
{ type: "start",   roomCode }                     // host only
{ type: "play",    roomCode, playerId, cardIds[] }
{ type: "pick",    roomCode, playerId, winnerId } // czar only
{ type: "redraw",  roomCode, playerId }           // Rebooting the Universe
{ type: "vote",    roomCode, playerId, targetId } // God is Dead mode
{ type: "leave",   roomCode, playerId }
```

### Server → Client events
```
{ type: "state_snapshot", ...full SessionState }  // sent on rejoin
{ type: "player_joined",  player }
{ type: "player_left",    playerId }
{ type: "game_started",   firstRound }
{ type: "round_started",  round, prompt, czarId, hand? }
{ type: "player_played",  playerId }              // face-down ack
{ type: "reveal_start" }
{ type: "card_revealed",  submissionIndex, fills[] }
{ type: "round_won",      winnerId, scores[] }
{ type: "round_end",      newPlayers[] }          // activates queued joiners
{ type: "game_over",      finalScores[] }
{ type: "error",          message }
```

### Reconnect flow
1. Client connects, sends `rejoin` with stored `playerId`
2. Server responds with `state_snapshot` — full current SessionState
3. Client hydrates immediately; shows "Reconnecting…" overlay until snapshot arrives
4. Server grace window: 30s before treating disconnect as permanent drop

---

## Game Rules Engine

### Core loop
1. Deal 10 white cards to each player at game start
2. Each round: rotate Czar, deal new black card from shuffled deck
3. Non-czar players submit `pick` white cards (1, 2, or 3 per black card)
4. Czar reveals and picks winner → winner gets black card as Awesome Point
5. All players replenish hand back to 10 cards
6. First to `roundsToWin` Awesome Points wins

### House Rules

| Rule | ID | Implementation |
|---|---|---|
| Rebooting the Universe | `rebooting` | Player action: spend 1 point → server redeals full hand |
| Packing Heat | `packing_heat` | On `pick: 2` black card → deal 1 extra white card to each player |
| Rando Cardrissian | `rando` | Auto-submit random white card each round; if Rando wins, game_over shame flag |
| God Is Dead | `godmode` | No Czar — all players vote; most votes wins; ties re-vote |
| Humanitarianism | `humanitarianism` | Once per round per player: swap entire hand |
| Happy Ending | `happy_ending` | Host may end game early with "Make a Haiku" forced as final black card |
| Haiku Mode | `haiku` | Submissions must fit 5-7-5 syllable count (loosely enforced — UI only, no hard block) |
| The Comeback | `comeback` | Player(s) tied for last place play 2 white cards per round (Czar sees double) |

---

## Mid-Game Join

1. Player joins via `/games/join` while game is in progress
2. Server adds them to `game:{code}:players` with status `queued`
3. Lobby shows "Game in progress — joining after this round"
4. On `round_end`, server moves all `queued` players to `active`, deals them a starting hand
5. Server emits `round_end` with `newPlayers[]` so all clients update their scoreboards
6. New player enters rotation immediately next round

---

## Card Data Seeding

On server start (`src/lib/seed.ts`):
1. `GET https://restagainsthumanity.com/api/v2/packs` — fetch all pack names
2. For each pack: `GET /cards?packs=<name>` — fetch black + white cards
3. Normalise black card blanks: replace `_` with `__________` in text
4. Upsert into `packs`, `black_cards`, `white_cards` tables (idempotent — skip if pack already exists)
5. Log summary: N packs, N black cards, N white cards seeded

---

## Database Schema (Drizzle)

```
packs          — id, name, slug, card_count
black_cards    — id, pack_id, text, pick (1|2|3)
white_cards    — id, pack_id, text
game_sessions  — id, code (6-char), status, config JSON, created_at
game_players   — id, session_id, username, role, score, status (active|queued|spectator)
game_rounds    — id, session_id, round_num, black_card_id, czar_id, winner_id
```

---

## Redis State Shape (per room)

```
game:{code}             hash: status, currentRound, totalRounds, czarIndex, config JSON
game:{code}:players     hash: playerId → GamePlayer JSON
game:{code}:round       hash: blackCardId, czarId, submissions JSON, winnerId
game:{code}:deck:black  list of card IDs (shuffled)
game:{code}:deck:white  list of card IDs (shuffled)
game:{code}:hand:{id}   set of white card IDs
game:{code}:channel     pub/sub channel
```
All keys: 24h TTL.

---

## Reconnect & Persistence

- `localStorage` key `cab_session` holds `{ roomCode, playerId, role, username }`
- On any route mount: if `cab_session` exists and URL doesn't match active game → redirect to `/games/$code/session`
- WebSocket hook sends `rejoin` immediately on connect; shows `Reconnecting…` overlay until `state_snapshot` received
- Server grace window: 30s — player not removed from game on disconnect within this window
- `playerId` is the Postgres `game_players.id` as a string (consistent with existing pattern)

---

## E2E Testing (Playwright)

Test matrix using multi-context (separate browser contexts per player):

### Core flows
- [ ] Create game → lobby → start → full round → winner declared → next round begins
- [ ] Join as player → play through a round
- [ ] Join as spectator → cannot submit cards, sees all reveals
- [ ] Room full → auto-spectate on join
- [ ] Host leaves → game ends gracefully

### Reconnect flows
- [ ] Player refreshes mid-picking → reconnects, hand restored, can still submit
- [ ] Czar refreshes during reveal → reconnects, can still pick winner
- [ ] Player disconnects and reconnects within 30s grace window → no state loss
- [ ] Player disconnects > 30s → removed from game, others continue

### Multi-blank flows
- [ ] Pick-2 black card: player selects 2 cards in order, badges shown
- [ ] Pick-3 black card: player selects 3 cards in order
- [ ] Czar sees all fills flattened in grid with player badges

### Mid-game join
- [ ] Join lobby while game in progress → see "joining after round" state
- [ ] Round ends → new player gets dealt cards and is active next round
- [ ] New player scoreboard appears for all existing players

### House rules
- [ ] Rebooting the Universe: spend point, redraw hand
- [ ] Rando Cardrissian: auto-submission appears in grid, can win
- [ ] God Is Dead: voting UI instead of czar pick
- [ ] The Comeback: last-place player submits 2 cards

### Game end
- [ ] First player to N points triggers game_over
- [ ] End screen shows correct winner and final scores
- [ ] Play again creates new lobby with same settings

### Infrastructure
- `playwright.config.ts`: `globalSetup` seeds test DB with all CAH packs, `globalTeardown` cleans up
- Tests run against real WS server + real Postgres + real Redis (no mocks)
- Separate `test` DB and Redis DB index from dev

---

## Docker Compose / Deployment

### Services
```yaml
services:
  app:      # TanStack Start (Node, port 3000)
  postgres: # postgres:16-alpine, named volume
  redis:    # valkey/valkey:latest, named volume
  cloudflared: # cloudflare/cloudflared:latest, TUNNEL_TOKEN from env
```

### Dockerfile (multi-stage)
- `build` stage: `node:22-alpine` + pnpm, runs `pnpm build`
- `run` stage: `node:22-alpine`, copies `.output/`, runs `node .output/server/index.mjs`

### Environment variables
`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `PORT` (default 3000), `TUNNEL_TOKEN`

### Notes
- App port not exposed to host (only to Docker network) — Cloudflare Tunnel forwards `yourdomain.com` → `http://app:3000`
- Tunnel natively proxies WebSocket upgrades — no extra config needed
- `docker-compose.prod.yml` override: `restart: unless-stopped`, memory limits, `NODE_ENV=production`
- Health checks on all three non-tunnel services

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
  components/
    ui/
      Card.tsx        — PromptCard, ResponseCard, CardBack
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
  lib/
    ws/
      useGameSocket.ts    — stub for frontend-first phase
      handler.ts          — h3 WebSocket server handler
    game-engine.ts        — round logic, house rules
    game-state.ts         — Redis state ops
    seed.ts               — card data seeding from REST Against Humanity API
    types.ts
  db/
    schema.ts             — Drizzle schema
    index.ts              — db singleton
  styles.css              — Tailwind v4 @theme + all design tokens + game CSS classes
tests/
  e2e/
    create-join-play.spec.ts
    reconnect.spec.ts
    mid-game-join.spec.ts
    house-rules.spec.ts
    multi-blank.spec.ts
  playwright.config.ts
Dockerfile
docker-compose.yml
docker-compose.prod.yml
.env.example
```
