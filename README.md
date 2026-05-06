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
3. Wait for enough people to show up (minimum 3, maximum chaos)
4. The host starts the game
5. Play cards. Pick winners. Lose faith in your friends. Gain points.
6. The person with the most points wins. Everyone else loses. Nobody learns anything.

---

## Features

- Real-time multiplayer via SSE (no WebSockets were harmed)
- 73 card packs — pick your poison
- Card Czar rotation every round
- Rando Cardrissian: an AI player who wins more than he should
- Spectator mode for people who showed up late or have dignity
- Mobile-friendly because bad decisions shouldn't require a laptop

---

## Running Locally

You'll need Docker, Node.js, and a complete disregard for your evening plans.

```bash
# Start Postgres + Redis
docker compose up postgres redis -d

# Install deps
pnpm install

# Seed card data (downloads from REST Against Humanity API)
pnpm seed

# Start dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Try not to play alone.

### Environment Variables

| Variable | Default |
|---|---|
| `DATABASE_URL` | `postgres://cab:cab_secret@localhost:5432/cardsagainstbhayanak` |
| `REDIS_URL` | `redis://localhost:6379` |
| `JWT_SECRET` | `dev_secret_change_in_production` |

---

## Stack

- **TanStack Start** — framework
- **TanStack Router** — file-based routing
- **Drizzle ORM** — database access
- **Postgres** — durable game history
- **Redis** — live game state, pub/sub
- **Tailwind CSS v4** — styles
- **Zod** — validation, because `any` is a lifestyle choice we rejected

---

## Disclaimer

Cards Against Humanity is a trademark of Cards Against Humanity LLC. This project is not affiliated with or endorsed by them. It's just a bunch of bad jokes on a server.

Play responsibly. Or don't. That's kind of the point.
