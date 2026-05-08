# Cards Against Bhayanak — Design Spec

**Date:** 2026-05-05  
**Status:** Approved

---

## Overview

A real-time multiplayer Cards Against Humanity web application. Players join a game session from their own devices via a short room code. A host configures the game and starts it; the server runs the game turn-by-turn, tracking scores in real time. After a set number of rounds the game ends, a scoreboard is shown, and a new game can begin. Players may optionally register a permanent profile (username + passphrase) to track stats and game history across sessions.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | TanStack Start (Vinxi/Nitro + React) |
| Styling | TailwindCSS + shadcn/ui |
| ORM | Drizzle ORM |
| Database | PostgreSQL — card data, user profiles, game history |
| Cache / Pub-Sub | Redis — live game state, WebSocket event fan-out |
| WebSockets | TanStack Start built-in (Vinxi WS routes) |
| Auth | JWT stored in browser (username + bcrypt passphrase) |
| Deployment | Docker Compose — single VPS (app + PostgreSQL + Redis) |

---

## Visual Design

- **Background & chrome:** Vibrant dark gradient (`#1a0533` → `#0d1a33`), electric gradient logo (`#f97316` → `#ec4899` → `#a855f7`), purple/pink accent buttons
- **Responsive:** All screens adapt to desktop and mobile. Tailwind breakpoints (`sm`, `md`, `lg`) drive layout changes — no separate mobile codebase.
- **Cards:** Always match the physical CAH card design
  - Black question cards: pure black background, white bold sans-serif text, "Cards Against Bhayanak" logo bottom-left, "PICK X" bottom-right, portrait orientation (~170×238px on desktop, full-width on mobile)
  - White answer cards: pure white background, black bold sans-serif text, same logo bottom-left, same portrait proportions (~170×238px on desktop, ~110×154px on mobile)
  - Hand cards: same proportions, scaled down (~100×140px desktop / ~72×100px mobile), horizontally scrollable row on both

### Responsive layout — Game Session screen

| Zone | Desktop | Mobile |
|---|---|---|
| Scoreboard | Tall side panel, right of black card, same height | Compact horizontal pill strip above the black card — each player is a pill: name · status · score, scrollable |
| Black card | Fixed ~170px wide, left of scoreboard | Full container width |
| Submitted answers | 4-column CSS grid — wraps to new rows automatically, never scrolls | 3-column CSS grid — same wrapping behaviour |
| Your hand | Horizontally scrollable row, scrollbar hidden via CSS, right-side gradient fade + animated `›` chevron indicates more cards | Same treatment, cards slightly narrower |

All other screens (Home, Auth, Create Game, Join, Lobby) use standard single-column stacking on mobile with full-width inputs and buttons.

---

## Player Identity

Two coexisting modes — guest and registered — playable in the same game session.

**Guest:** Enter a display name + room code. No registration. Scores tracked within the session only.

**Registered:** Choose a username + passphrase (no email). JWT stored in browser. Display name defaults to username. Persistent stats tracked across sessions.

**Spectator:** Join any active or waiting game in watch-only mode. No hand, no card play, no score. Sees the scoreboard, the current question card, and all submitted/selected answer cards after they are revealed. Never sees any player's hand.

### Registration flow
1. Pick username (unique, alphanumeric + underscores)
2. Pick a passphrase (no email, no recovery — keep it simple)
3. JWT issued, stored in `localStorage`

### Stats tracked per profile
- Games played / games won
- Total Awesome Points earned
- Best single-game score
- Game history (last 50 games)

---

## Screens

### 1. Home
Large gradient logo centered. Three actions:
- **Create Game** → Create Game screen
- **Join Game** → Join Game screen  
- **Sign In / Register** → Auth screen

If a JWT is present: shows "Signed in as @username" with a sign-out link. Create Game and Join Game pre-fill the username.

### 2. Sign In / Register
Tabbed form (Sign In / Register). Fields: username + passphrase. No email. JWT stored on success, redirects to Home.

### 3. Create Game
Form fields:
- **Rounds** (number input, default 8)
- **Max players** (number input, default 10)
- **Card packs** — scrollable chip picker showing all 73 official packs; chips toggle selected/unselected
- **House rules** — checkboxes: Rando Cardrissian, Happy Ending, Packing Heat

On submit: creates a game session in PostgreSQL + Redis, generates a 6-char room code, redirects host to the Lobby.

### 4. Join Game
Fields:
- **Display name** — auto-populated from JWT profile, editable for guests
- **Room code** — large styled input, all-caps
- **Join as:** toggle — "Player" (default) or "Spectator"

On submit: validates room exists and is in WAITING or ACTIVE state. Adds participant to session and redirects to Lobby or directly to Game Session if already in progress.

- **Spectators** — join immediately in watch-only mode at any point.
- **Players joining mid-game** — marked as `pending` until the current round ends. They see the game screen in spectator-like mode (scoreboard, question card, revealed answer cards, no hand) for the remainder of the round, then are dealt into the game at the start of the next round when a new Card Czar is selected.

### 5. Lobby
Displays the room code prominently. Lists joined players and, separately, any spectators already waiting. Host sees a "Start Game" button (enabled when ≥ 3 players, or ≥ 2 players when Rando Cardrissian is enabled). Non-hosts and spectators see "Waiting for host to start…". Real-time player and spectator join/leave via WebSocket.

### 6. Game Session
Three visual zones:

**Top bar:** Logo left, "Round N / Total · Room CODE" right.

**Middle row (side-by-side):**
- *Left:* Black question card, portrait, full size — the focal point of each round
- *Right:* Scoreboard panel (same height as card) — players listed with scores, Czar highlighted in orange with "CZAR" badge, played/thinking status per player, round progress bar at bottom

**Submitted answers:** Horizontally scrollable row of white answer cards, same portrait proportions as the black card. Anonymous until all players have submitted. Pending players show a placeholder card. Card Czar sees hover lift + purple glow on selection; other players see cards read-only.

**Your hand:** Horizontally scrollable row of smaller white cards (~100×140px). Tap to play. Played card gets a green glow ring and dims. During Czar's turn, hand is fully dimmed (not interactive). Spectators never see this section.

**Rando Cardrissian** appears in the player list as "🤖 Rando", always shows ✓ immediately when the round starts.

**Spectator view:** Identical layout to the full game screen — top bar, middle row (question card + scoreboard), and submitted answer cards — but with no hand section. The scoreboard lists active players and their scores; spectators are shown in a separate "Watching" count below the scoreboard. Spectators see submitted cards only after all players have played (same reveal timing as players), and see the winning card highlighted after the Czar picks.

### 7. Round Result
After Czar picks: winner's card is highlighted with a gold glow, winner's name revealed beneath it, score increments in the scoreboard. Round auto-advances after 10 seconds.

### 8. End Screen / Final Scoreboard
Full scoreboard with winner crowned. "Play Again" button (host) resets to Lobby with same players and config.

---

## Game Rules (Standard + House Rules)

### Standard flow
1. Shuffle selected black and white card decks at game start (loaded from PostgreSQL into Redis)
2. Deal 7 white cards to each player
3. Randomly select first Card Czar; rotate clockwise each round
4. Reveal one black card; Czar does not play
5. All non-Czar players (including Rando if enabled) submit their white card(s) — hidden from Czar until all have played
6. Cards revealed anonymously (no name shown); Czar picks the funniest
7. Winner earns one Awesome Point; winning card attributed after pick
8. Replenish each player's hand to 7 cards; deal 7 cards to any `isPending` players and mark them active — they participate from this round onwards
9. Repeat for N rounds; game ends → Final Scoreboard

### House rules

**Rando Cardrissian:** A bot player added to the game. Each round it randomly selects a white card from its own hand (replenished like other players). If Rando wins the game, the humans feel appropriately ashamed.

**Happy Ending:** The final round always uses the "Make a Haiku" black card (pick 3, one word per card). If this card is not in the selected packs it is injected for the final round only.

**Packing Heat:** When a black card requires Pick 2, each player draws one extra white card before playing (then plays 2). The extra card is not returned.

---

## Architecture

### Containers (Docker Compose)
```
app        — TanStack Start (Node.js, port 3000)
postgres   — PostgreSQL 16
redis      — Redis 7
```

### Game State — Redis

Active game state lives in Redis. Keys are namespaced by `roomCode`:

| Key | Type | Contents |
|---|---|---|
| `game:{code}` | Hash | status, currentRound, totalRounds, czarIndex, config JSON |
| `game:{code}:players` | Hash | playerId → `{name, userId?, score, isHost, isSpectator, isPending}` JSON — `isPending` true for mid-game joiners not yet dealt in |
| `game:{code}:deck:black` | List | remaining black card IDs |
| `game:{code}:deck:white` | List | remaining white card IDs |
| `game:{code}:hand:{playerId}` | Set | white card IDs in player's hand |
| `game:{code}:round` | Hash | blackCardId, submissions `{playerId→cardIds[]}`, winnerId |
| `game:{code}:channel` | Pub/Sub | event fan-out channel |

TTL of 24h on all keys — abandoned games clean themselves up.

### Game State — PostgreSQL

Persistent data only:

| Table | Purpose |
|---|---|
| `users` | id, username (unique), passphrase_hash, created_at |
| `packs` | id, name, official |
| `black_cards` | id, pack_id, text, pick |
| `white_cards` | id, pack_id, text |
| `game_sessions` | id, room_code, config JSON, status, started_at, ended_at |
| `game_players` | id, session_id, user_id (nullable), display_name, is_spectator, joined_round, final_score |
| `game_rounds` | id, session_id, round_num, black_card_id, winner_player_id |

### WebSocket Architecture

One Vinxi WS route: `/_ws/game/:roomCode`

On connect:
1. Validate `roomCode` exists in Redis
2. Subscribe to `game:{roomCode}:channel` via Redis pub/sub
3. Register the connection in a server-side `Map<roomCode, Set<WebSocket>>`

On Redis pub/sub message: forward to all live connections for that room.

On disconnect: remove from map, publish `player:left` event.

### WebSocket Event Types

| Event | Direction | Payload |
|---|---|---|
| `player:joined` | server → clients | `{playerId, name, isSpectator}` |
| `player:left` | server → clients | `{playerId}` |
| `game:snapshot` | server → one client | Full current state sent to a newly connected or rejoining client (current round, scores, revealed cards) — spectators receive this without hand data |
| `game:started` | server → clients | `{config}` |
| `round:started` | server → clients | `{roundNum, blackCard, czarId}` |
| `card:played` | server → clients | `{playerId}` (no card content) |
| `all:played` | server → clients | `{submissions: [{submissionId, cards[]}]}` — no player IDs until czar picks |
| `czar:picked` | server → clients | `{winnerId, winnerName, submissionId, winningCards}` |
| `round:ended` | server → clients | `{scores}` |
| `game:ended` | server → clients | `{finalScores}` |

### Card Seeder

A standalone script (`scripts/seed-cards.ts`) run once at setup:
1. `GET /api/v2/packs` → list of pack names
2. For each pack: `GET /api/v2/cards?packs={name}` → black + white cards
3. Upsert into `packs`, `black_cards`, `white_cards` tables
4. Script is idempotent — safe to re-run

The app never calls the external API at runtime.

---

## API Routes (TanStack Start server functions / API routes)

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Create user account |
| POST | `/api/auth/login` | Validate credentials, return JWT |
| POST | `/api/games` | Create game session, return room code |
| POST | `/api/games/:code/join` | Join a session (body: `{displayName, spectator: bool}`) |
| POST | `/api/games/:code/start` | Host starts the game |
| POST | `/api/games/:code/play` | Player submits white card(s) |
| POST | `/api/games/:code/pick` | Czar picks winning card |
| GET  | `/api/users/:username/stats` | Fetch profile stats |
| WS   | `/_ws/game/:code` | WebSocket connection |

---

## Verification Plan

1. **Seed:** Run `scripts/seed-cards.ts`, confirm all 73 packs load into PostgreSQL
2. **Create + Join:** Open two browser tabs, create a game in one, join from the other with a guest name — both should appear in the Lobby
3. **Real-time:** Open 4 tabs (3 players + 1 Czar), start game, confirm all see the same black card and scoreboard simultaneously
4. **Play round:** All 3 players submit cards, confirm Czar sees revealed cards and can pick — confirm winner's score increments in all tabs
5. **House rules:** Enable Rando Cardrissian, confirm bot appears and submits each round
6. **End game:** Play N rounds, confirm final scoreboard appears and "Play Again" resets correctly
7. **Persistent profile:** Register, play a game, sign out, sign back in — confirm stats updated

---

## Out of Scope (v1)

- Password reset / account recovery
- Custom card creation
- Mobile app (web-responsive only)
- Horizontal scaling (single-instance VPS)
