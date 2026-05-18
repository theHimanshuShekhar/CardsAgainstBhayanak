# Cards Against Bhayanak

A real-time multiplayer Cards Against Humanity clone. Jackbox-style: no accounts, 6-char room codes, up to 10 players. Includes all 8 official 2014 CAH house rules.

**Canonical spec:** [`SPEC.md`](SPEC.md)  
**Agent guidance:** [`CLAUDE.md`](CLAUDE.md)

## Quickstart

```bash
# Start Postgres + Redis
docker compose up -d postgres redis

# Install dependencies
pnpm install

# Apply schema
pnpm db:push

# Seed cards from REST Against Humanity API
pnpm seed

# Start dev server
pnpm dev
# → http://localhost:3000
```

## Environment variables

For the **full Docker stack**, copy `.env.example` to `.env`. `DATABASE_URL`
and `REDIS_URL` are derived inside `docker-compose.yml` — don't set them.
`compose up` fails fast unless the two required vars are set:

| Variable                           | Required | Purpose                                       |
| ---------------------------------- | -------- | --------------------------------------------- |
| `POSTGRES_PASSWORD`                | ✅       | Postgres password; also feeds `DATABASE_URL`  |
| `SESSION_SECRET`                   | ✅       | HMAC secret for session tokens (≥32 chars)    |
| `PORT`                             |          | Host/container port (default `3000`)          |
| `NODE_ENV`                         |          | Default `production` (enforces rate limiting) |
| `AXIOM_TOKEN` + `AXIOM_DATASET`    |          | Log shipping (prod only)                      |
| `POSTHOG_API_KEY` + `POSTHOG_HOST` |          | Product analytics / replay (prod only)        |

For **local `pnpm dev`** against `docker compose up -d postgres redis`, set
`DATABASE_URL`, `REDIS_URL`, and `SESSION_SECRET` directly in your shell/`.env`.

## Commands

| Command          | Purpose                                   |
| ---------------- | ----------------------------------------- |
| `pnpm dev`       | Dev server with HMR                       |
| `pnpm build`     | Production build                          |
| `pnpm start`     | Run production build                      |
| `pnpm typecheck` | TypeScript check                          |
| `pnpm lint`      | ESLint                                    |
| `pnpm test`      | Unit tests (Vitest)                       |
| `pnpm test:e2e`  | E2E tests (Playwright, requires DB+Redis) |
| `pnpm db:push`   | Apply schema changes                      |
| `pnpm db:studio` | Drizzle Studio                            |
| `pnpm seed`      | Seed card packs                           |

## Production

A single `docker-compose.yml` serves dev and prod (no separate prod compose
file). Provide a `.env` (see above; `SESSION_SECRET` ≥32 chars —
`openssl rand -hex 32`), then:

```bash
docker compose up -d
```

`NODE_ENV` defaults to `production` (rate limiting enforced). All three
services have healthchecks; the app is `build: .` — rebuild with
`docker compose build app && docker compose up -d app` after source changes.

Cloudflare Tunnel is managed externally — see `SPEC.md § Deployment` for details.
