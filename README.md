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

| Variable                           | Required | Purpose                                                            |
| ---------------------------------- | -------- | ------------------------------------------------------------------ |
| `POSTGRES_PASSWORD`                | ✅       | Postgres password; also feeds `DATABASE_URL`                       |
| `SESSION_SECRET`                   | ✅       | HMAC secret for session tokens (≥32 chars)                         |
| `PORT`                             |          | Host/container port (default `3000`)                               |
| `APP_BIND_IP`                      |          | Compose host bind address (default `127.0.0.1`)                    |
| `CAB_TRUSTED_PROXY_IPS`            |          | Comma-separated immediate Cloudflare ingress IPs; empty by default |
| `NODE_ENV`                         |          | Default `production` (enforces rate limiting)                      |
| `AXIOM_TOKEN` + `AXIOM_DATASET`    |          | Log shipping (prod only)                                           |
| `POSTHOG_API_KEY` + `POSTHOG_HOST` |          | Product analytics / replay (prod only)                             |

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

E2E tests use disposable PostgreSQL and Redis databases: global teardown removes game data and flushes the selected Redis database. The automatic Playwright server uses a 2000ms round-result pause so browser tests can reload while the winning cards remain visible. Production keeps its 4000ms pause.

When targeting an already running server with `CAB_E2E_BASE`, start that server with `CAB_ROUND_RESULT_PAUSE_MS=2000` (or the production 4000ms pause), and use the same isolated database and Redis settings for the test runner. A 150ms result pause is too short for the winner refresh assertions.

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

### Trusted ingress and rate-limit identity

The production server uses the TCP socket's remote IP for create/join budgets.
`CAB_TRUSTED_PROXY_IPS` is an explicit allowlist of literal IPv4/IPv6 addresses
of immediate Cloudflare Tunnel peers. It defaults to empty, including for
loopback. Only an allowlisted peer may supply a valid `CF-Connecting-IP`.
Missing or invalid values fall back to that peer's socket IP. IPv6 spellings
and IPv4-mapped IPv6 are canonicalized; `X-Forwarded-For` and `Forwarded` are
ignored. Hostnames, CIDRs, and wildcards are not supported; invalid allowlist
entries prevent the production server from starting.

Compose publishes the app on `127.0.0.1:${PORT:-3000}`, preserving the external
host `cloudflared` tunnel's `http://localhost:3000` origin. Set
`CAB_TRUSTED_PROXY_IPS` to the actual peer address seen inside the app container;
Docker NAT often presents the bridge gateway for host-originated connections.
Inspect your Docker network's gateway and verify the peer in your own topology
before configuring it. Until configured, tunnel visitors share the tunnel
peer's budget. A separately managed tunnel container can use the app's Docker
network address with a stable, explicitly allowlisted tunnel address. There is
no tunnel service in this Compose stack.

Trusted ingress must overwrite the visitor's `CF-Connecting-IP`, and access to
the origin through trusted peers must be restricted to that ingress. Processes
on an allowlisted host, or other traffic NATed to the same allowlisted gateway,
are inside this trust boundary and can assert client identity. Loopback binding
limits host port exposure; it does not authenticate local processes or isolate
containers on a shared network. Keep that network restricted. `APP_BIND_IP`
can select another host interface when an external tunnel requires it; restrict
access to that interface before enabling header trust.

For local `pnpm start`, the allowlist is empty unless explicitly configured.
Local `pnpm dev` may lack socket context, in which case identity falls back to
`unknown`; it still ignores forwarding headers. Rate enforcement remains
enabled only with `NODE_ENV=production`. Production HTTP identity regression
tests start their own production entry server and real reverse proxy against
the test suite's disposable DB/Redis:

```bash
pnpm build
pnpm exec playwright test tests/e2e/http-client-identity.spec.ts
```
