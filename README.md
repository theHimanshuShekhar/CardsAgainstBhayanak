# Cards Against Bhayanak

> A party game for horrible people with good Wi-Fi.

Play at **[cards.bhayanak.net](https://cards.bhayanak.net)**

---

## What is this?

Cards Against Bhayanak is a real-time multiplayer Cards Against Humanity clone for when you've exhausted your board game collection, your friends have questionable taste, and someone inevitably says "we should make our own version."

Someone did.

Each round, one player becomes the **Card Czar** and draws a black card with a fill-in-the-blank prompt. Everyone else plays the funniest (or most disturbing) white card from their hand. The Czar picks a winner. Repeat until someone rage-quits or you run out of rounds.

---

## How to Play

1. Go to [cards.bhayanak.net](https://cards.bhayanak.net)
2. Create a game or join one with a room code
3. Wait for enough people to show up (minimum 3 real players)
4. The host starts the game
5. Play cards. Pick winners. Lose faith in your friends. Gain points.
6. The person with the most points wins. Everyone else loses. Nobody learns anything.
7. Hit **Play Again** to rematch with the same crew

---

## Features

- Real-time multiplayer via WebSocket
- 73 card packs — pick your poison
- Card Czar rotation every round
- Spectator mode for people who showed up late or have dignity
- User accounts with game history and stats
- **House rules:**
  - **Rando Cardrissian** — an AI player who wins more than he should
  - **Happy Ending** — final round is always a haiku prompt
  - **Packing Heat** — extra white card dealt on multi-pick black cards
- Play Again / rematch at end of game
- Mobile-friendly because bad decisions shouldn't require a laptop

---

## Running Locally

You'll need Docker, Node.js 22+, and pnpm.

```bash
# Start Postgres + Redis
docker compose up postgres redis -d

# Install deps
pnpm install

# Push schema to database
pnpm db:push

# Seed card data (downloads from REST Against Humanity API, idempotent)
pnpm seed

# Start dev server (app + WebSocket on port 3000)
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://cab:cab_secret@localhost:5432/cardsagainstbhayanak` | Set by docker-compose |
| `REDIS_URL` | `redis://localhost:6379` | Set by docker-compose |
| `JWT_SECRET` | `dev_secret_change_in_production` | Override in production |
| `POSTGRES_USER` | `cab` | Postgres container only |
| `POSTGRES_PASSWORD` | `cab_secret` | Postgres container only |
| `POSTGRES_DB` | `cardsagainstbhayanak` | Postgres container only |

Copy `.env.example` to `.env` and adjust as needed.

---

## Deploying with Docker

```bash
# Build and start everything (app + Postgres + Redis)
docker compose up -d

# First-time: push schema and seed cards
docker compose exec app sh -c "pnpm db:push && pnpm seed"
```

For production, set a real `JWT_SECRET` and strong `POSTGRES_PASSWORD` in your `.env` before starting.

---

## Running Tests

```bash
# Unit / integration tests (require running Postgres + Redis)
pnpm test

# E2E tests (Playwright, starts its own server)
pnpm test:e2e
```

---

## Stack

| Layer | Tech |
|---|---|
| Framework | TanStack Start (React, SSR) |
| Routing | TanStack Router (file-based) |
| Real-time | Native WebSocket (`ws` package) |
| Database | Postgres via Drizzle ORM |
| Cache / pubsub | Redis via ioredis |
| Auth | JWT (jose, HS256) + bcryptjs |
| Validation | Zod |
| Styles | Tailwind CSS v4 |
| Tests | Vitest (unit) + Playwright (E2E) |

---

## Disclaimer

Cards Against Humanity is a trademark of Cards Against Humanity LLC. This project is not affiliated with or endorsed by them. It's just a bunch of bad jokes on a server.

Play responsibly. Or don't. That's kind of the point.
