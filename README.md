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

Copy `.env.example` to `.env` and fill in:

| Variable                           | Purpose                    |
| ---------------------------------- | -------------------------- |
| `DATABASE_URL`                     | Postgres connection string |
| `REDIS_URL`                        | Redis/Valkey URL           |
| `SESSION_SECRET`                   | HMAC secret (≥32 chars)    |
| `PORT`                             | Default `3000`             |
| `AXIOM_TOKEN` + `AXIOM_DATASET`    | Log shipping (prod only)   |
| `POSTHOG_API_KEY` + `POSTHOG_HOST` | Analytics                  |

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

```bash
docker compose -f docker-compose.prod.yml up -d
```

Cloudflare Tunnel is managed externally — see `SPEC.md § Deployment` for details.
