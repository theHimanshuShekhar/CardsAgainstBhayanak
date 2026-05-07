# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (requires Docker services running)
docker compose up postgres redis -d
pnpm dev                        # starts app + WebSocket server together on port 3000

# Build & type-check
pnpm build                      # production build; also regenerates routeTree.gen.ts
pnpm tsc --noEmit               # type-check only

# Tests (require live Postgres + Redis on default ports)
pnpm test                       # run all tests once
pnpm test:watch                 # watch mode
pnpm vitest run tests/lib/game-engine.test.ts  # run a single test file

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

### Real-time: WebSocket (same port as app)
Real-time events use native WebSocket at `ws://host/api/games/$code/ws`. The server publishes to Redis pub/sub (`game:{code}:channel`); the WS handler subscribes and forwards messages to all connected peers in the room.

The WS handler lives in `src/ws/handler.ts` and is attached to Vite's HTTP server via a custom Vite plugin in `vite.config.ts` (`gameWsPlugin`). No separate process needed — everything runs on port 3000.

The client hook is `src/hooks/useGameSocket.ts` — uses native `WebSocket`, exposes `on(eventName, handler)`, and implements exponential-backoff reconnection (1 s → 30 s). On connect, the server sends a `game:snapshot` event with full current state so clients hydrate without waiting.

### State: Redis (live) + Postgres (durable)
**Redis** (ioredis, 24h TTL) holds all live game state:
- `game:{code}` — hash: `status`, `currentRound`, `totalRounds`, `czarIndex`, `config`
- `game:{code}:players` — hash: playerId → `GamePlayer` JSON
- `game:{code}:round` — hash: `blackCardId`, `czarId`, `submissions` (JSON), `winnerId`
- `game:{code}:deck:black` / `game:{code}:deck:white` — lists (shuffle order)
- `game:{code}:hand:{playerId}` — set of white card IDs

**Postgres** (Drizzle ORM, `pnpm db:push`) stores durable history: `users`, `packs`, `black_cards`, `white_cards`, `game_sessions`, `game_players`, `game_rounds`.

Two Redis connections are needed: one shared singleton (`getRedis()`) for commands, and a **dedicated connection per room** (`newRedisSubscriber()`) because a subscribed ioredis client cannot issue regular commands. Rooms share one subscriber; it is torn down when the last peer disconnects.

### Game Flow
```
POST /api/games/         → creates Redis state + Postgres game_sessions row
POST /api/games/$code/join  → adds player to Redis + Postgres game_players
POST /api/games/$code/start → publishes game:started; triggers handleGameStarted() non-blocking
  └─ game-event-handler.ts: loadDecksIntoRedis → ensureRandoInGame? → startRound
POST /api/games/$code/play  → submitCards() → publishes all:played (with card texts) when all submitted
POST /api/games/$code/pick  → pickWinner() → updates scores, persists round, schedules next round (10s delay)
```

`startRound` increments round, rotates Czar index, draws black card, deals/tops-up hands, and publishes `round:started`. The next round is triggered by `setTimeout(..., 10_000)` inside `pickWinner`.

### Auth
JWT (jose, HS256, 7-day expiry) issued at register/login. `src/lib/auth.ts` signs/verifies server-side. `src/contexts/AuthContext.tsx` decodes the token client-side using `decodeJwt` from jose (no verification — expiry checked only). Passwords use bcryptjs.

Player IDs in Redis are the Postgres `game_players.id` (as a string). Rando Cardrissian uses the literal string `"rando_cardrissian"` — `pickWinner` guards against using it as a DB foreign key.

### Styling
Tailwind CSS v4 — configured via `src/styles.css` (`@import "tailwindcss"`, `@theme`, `@utility`) rather than `tailwind.config.ts` (which does not exist). Custom utilities (e.g. `scrollbar-none`) go in `src/styles.css` using `@utility`.

### Tests
All tests are integration tests hitting real Redis and Postgres — no mocks. Docker services must be running. Test files live in `tests/` at the project root, mirroring the `src/` structure (`tests/lib/`, `tests/db/`, `tests/routes/`).

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
