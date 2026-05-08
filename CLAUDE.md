# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (requires Docker services running)
docker compose up postgres redis -d
pnpm dev                        # starts app + WebSocket server together on port 3000

# Build & type-check
pnpm build                      # production build: vite build + esbuild for ws handler
pnpm tsc --noEmit               # type-check only

# Production
pnpm start                      # runs node server.mjs (requires a prior pnpm build)

# Tests (require live Postgres + Redis on default ports)
pnpm test                       # run all unit/integration tests once
pnpm test:watch                 # watch mode
pnpm vitest run tests/lib/game-engine.test.ts  # run a single test file
pnpm test:e2e                   # Playwright E2E tests (spins up its own server)
pnpm test:e2e:ui                # Playwright with interactive UI

# Database
pnpm db:push                    # push schema changes to Postgres (Drizzle, no migrations)
pnpm seed                       # seed card data from REST Against Humanity API (idempotent)
```

**Important:** After adding or renaming route files, run `pnpm build` to regenerate `src/routeTree.gen.ts`. TypeScript will error on `createFileRoute` strings and `Link to=` props until this is done.

## Environment Variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://cab:cab_secret@localhost:5432/cardsagainstbhayanak` | Set by docker-compose |
| `REDIS_URL` | `redis://localhost:6379` | Set by docker-compose |
| `JWT_SECRET` | `dev_secret_change_in_production` | Override in production |
| `POSTGRES_USER` | `cab` | Postgres container only |
| `POSTGRES_PASSWORD` | `cab_secret` | Postgres container only |
| `POSTGRES_DB` | `cardsagainstbhayanak` | Postgres container only |
| `ROUND_DELAY_MS` | `10000` | Milliseconds between rounds (useful to lower in tests) |

## Architecture

### Framework
TanStack Start (React, file-based routing via `@tanstack/react-router`). Every file under `src/routes/` becomes a route. The auto-generated `src/routeTree.gen.ts` must not be edited manually.

### API Routes
API handlers live alongside page routes using the `server.handlers` pattern — not `createAPIFileRoute`:

```typescript
export const Route = createFileRoute("/api/games/$code/hand")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        return Response.json({ ... });
      },
    },
  },
});
```

All request body and query param validation uses **Zod** (`safeParse` → return 400 on failure). Route `validateSearch` also uses Zod schemas (`.parse` as the validator function).

### API Surface

```
POST /api/auth/register             → create user account
POST /api/auth/login                → returns JWT

POST /api/games/                    → create game + host player
POST /api/games/$code/join          → join as player or spectator
POST /api/games/$code/start         → host starts the game
POST /api/games/$code/play          → submit white card(s)
POST /api/games/$code/pick          → czar picks winning submission
POST /api/games/$code/rematch       → create new game with same players/config
GET  /api/games/$code/hand          → fetch current player's hand
GET  /api/games/$code/round         → fetch current round state
GET  /api/packs                     → list available card packs
GET  /api/users/$username/stats     → player profile and game history

WS   /api/games/$code/ws            → real-time game events
```

### Real-time: WebSocket (same port as app)
Real-time events use native WebSocket at `ws://host/api/games/$code/ws`. The server publishes to Redis pub/sub (`game:{code}:channel`); the WS handler subscribes and forwards messages to all connected peers in the room.

The WS handler lives in `src/ws/handler.ts` and is attached to:
- **Dev**: Vite's HTTP server via a custom Vite plugin in `vite.config.ts` (`gameWsPlugin`)
- **Production**: the Node.js `http.Server` created in `server.mjs`

No separate process needed — everything runs on port 3000.

The client hook is `src/hooks/useGameSocket.ts` — uses native `WebSocket`, exposes `on(eventName, handler)`, and implements exponential-backoff reconnection (1 s → 30 s). On connect, the server sends a `game:snapshot` event with full current state so clients hydrate without waiting.

### State: Redis (live) + Postgres (durable)
**Redis** (ioredis, 24h TTL) holds all live game state:
- `game:{code}` — hash: `status`, `currentRound`, `totalRounds`, `czarIndex`, `config`
- `game:{code}:players` — hash: playerId → `GamePlayer` JSON
- `game:{code}:round` — hash: `blackCardId`, `czarId`, `sub:{playerId}` (JSON card array per player), `winnerId`, `allPlayedFired`
- `game:{code}:deck:black` / `game:{code}:deck:white` — lists (shuffle order)
- `game:{code}:hand:{playerId}` — set of white card IDs

**Postgres** (Drizzle ORM, `pnpm db:push`) stores durable history: `users`, `packs`, `black_cards`, `white_cards`, `game_sessions`, `game_players`, `game_rounds`.

Two Redis connections are needed: one shared singleton (`getRedis()`) for commands, and a **dedicated connection per room** (`newRedisSubscriber()`) because a subscribed ioredis client cannot issue regular commands. Rooms share one subscriber; it is torn down when the last peer disconnects.

### Game Flow
```
POST /api/games/            → creates Redis state + Postgres game_sessions row
POST /api/games/$code/join  → adds player to Redis + Postgres game_players
POST /api/games/$code/start → publishes game:started; triggers handleGameStarted() non-blocking
  └─ game-event-handler.ts: loadDecksIntoRedis → ensureRandoInGame? → startRound
POST /api/games/$code/play  → submitCards() → publishes all:played (with card texts) when all submitted
POST /api/games/$code/pick  → pickWinner() → updates scores, persists round, schedules next round (ROUND_DELAY_MS)
POST /api/games/$code/rematch → clones config + players into a new room, publishes game:rematch to old room
```

`startRound` increments round, rotates Czar index, draws black card, deals/tops-up hands, and publishes `round:started`. The next round is triggered by `setTimeout(..., ROUND_DELAY_MS)` inside `pickWinner`. When all rounds complete, `endGame` persists final scores and winner flags to `game_players` and publishes `game:ended`.

Submissions are stored as individual hash fields (`sub:{playerId}`) to avoid concurrent-write races. An `hsetnx` guard on `allPlayedFired` ensures `all:played` fires exactly once.

### Auth
JWT (jose, HS256, 7-day expiry) issued at register/login. `src/lib/auth.ts` signs/verifies server-side. `src/contexts/AuthContext.tsx` decodes the token client-side using `decodeJwt` from jose (no verification — expiry checked only). Passwords use bcryptjs.

Player IDs in Redis are the Postgres `game_players.id` (as a string). Rando Cardrissian uses the literal string `"rando_cardrissian"` — `pickWinner` guards against using it as a DB foreign key.

### Styling
Tailwind CSS v4 — configured via `src/styles.css` (`@import "tailwindcss"`, `@theme`, `@utility`) rather than `tailwind.config.ts` (which does not exist). Custom utilities (e.g. `scrollbar-none`) go in `src/styles.css` using `@utility`.

### Tests
Unit/integration tests hit real Redis and Postgres — no mocks. Docker services must be running. Test files live in `tests/` at the project root, mirroring the `src/` structure (`tests/lib/`, `tests/db/`, `tests/routes/`).

E2E tests use Playwright and live in `e2e/tests/`. The config is at `e2e/playwright.config.ts`. Shared fixtures and helpers are in `e2e/fixtures/game.ts`. The test server sets `ROUND_DELAY_MS=1000` to keep tests fast.

### Production Server
`pnpm build` produces:
- `dist/server/server.js` — TanStack Start SSR fetch handler (ESM, references bare npm packages)
- `dist/client/` — static client assets
- `dist/ws.mjs` — bundled WebSocket handler (compiled from `src/ws/handler.ts` via esbuild)

`server.mjs` (project root) creates a Node.js HTTP server, bridges incoming requests to the TanStack Start fetch handler, and attaches the WebSocket server on the same port. The Dockerfile uses a multi-stage build: full dev install + build in the first stage, then prod-only `node_modules` + `dist/` copied into the final image.

## TanStack Documentation

Fetch up-to-date TanStack docs with: `npx @tanstack/intent@latest load <skill-id>`

| Topic | Skill ID |
|---|---|
| Start core overview (Vite plugin, entry points, routeTree) | `@tanstack/start-client-core#start-core` |
| **Server API routes** (`server.handlers` pattern) | `@tanstack/start-client-core#start-core/server-routes` |
| Server functions (`createServerFn`, `useServerFn`) | `@tanstack/start-client-core#start-core/server-functions` |
| Middleware (`createMiddleware`, context passing) | `@tanstack/start-client-core#start-core/middleware` |
| Execution model (server/client boundaries, env vars) | `@tanstack/start-client-core#start-core/execution-model` |
| Deployment (Cloudflare, Vercel, Node, SPA, SSR) | `@tanstack/start-client-core#start-core/deployment` |
| Server runtime (cookies, sessions, `AsyncLocalStorage`) | `@tanstack/start-server-core#start-server-core` |
| React Start bindings (`createStart`, `StartClient`) | `@tanstack/react-start#react-start` |
| Next.js → TanStack Start migration | `@tanstack/react-start#lifecycle/migrate-from-nextjs` |
| React Server Components (RSC, `renderServerComponent`) | `@tanstack/react-start#react-start/server-components` |
| Router core (route trees, `createRouter`, file naming) | `@tanstack/router-core#router-core` |
| **Search params** (`validateSearch`, Zod adapters) | `@tanstack/router-core#router-core/search-params` |
| **Path params** (`$paramName`, `useParams`) | `@tanstack/router-core#router-core/path-params` |
| Data loading (`loader`, `staleTime`, deferred data) | `@tanstack/router-core#router-core/data-loading` |
| Navigation (`Link`, `useNavigate`, preloading) | `@tanstack/router-core#router-core/navigation` |
| Auth & route guards (`beforeLoad`, `redirect`) | `@tanstack/router-core#router-core/auth-and-guards` |
| Code splitting (`.lazy.tsx`, `autoCodeSplitting`) | `@tanstack/router-core#router-core/code-splitting` |
| Not-found & error handling (`notFoundComponent`) | `@tanstack/router-core#router-core/not-found-and-errors` |
| SSR (streaming, dehydration/hydration) | `@tanstack/router-core#router-core/ssr` |
| Type safety (never cast, `Register`, `getRouteApi`) | `@tanstack/router-core#router-core/type-safety` |
| Router bundler plugin (Vite, Webpack, route gen) | `@tanstack/router-plugin#router-plugin` |
| Virtual file routes (programmatic route trees) | `@tanstack/virtual-file-routes#virtual-file-routes` |
| Devtools setup (Vite plugin, `@tanstack/devtools-vite`) | `@tanstack/devtools-vite#devtools-vite-plugin` |
