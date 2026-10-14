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
pnpm db:migrate

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

| Command           | Purpose                                   |
| ----------------- | ----------------------------------------- |
| `pnpm dev`        | Dev server with HMR                       |
| `pnpm build`      | Production build                          |
| `pnpm start`      | Run production build                      |
| `pnpm typecheck`  | TypeScript check                          |
| `pnpm lint`       | ESLint                                    |
| `pnpm test`       | Unit tests (Vitest)                       |
| `pnpm test:e2e`   | E2E tests (Playwright, requires DB+Redis) |
| `pnpm db:migrate` | Apply reviewed versioned migrations       |
| `pnpm db:studio`  | Drizzle Studio                            |
| `pnpm seed`       | Seed card packs                           |

`pnpm test:integration` runs the real-service game-engine regressions separately
from unit tests. Set `DATABASE_URL` and `REDIS_URL` to dedicated disposable
PostgreSQL/Redis databases, apply `pnpm db:migrate`, and seed the card catalog
with `pnpm seed` before running it. A seeded pre-migration test database must
first use `pnpm db:baseline`. Missing services or cards fail this command;
these tests are never silently skipped. The timer regression controls only
wall-clock time and scheduled round callbacks, preserving monotonic rate-limit
clocks and real service IO. It observes the engine event stream delivered to
WebSocket clients and removes its own room fixtures afterward.

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

### Seeded replay regression

`tests/e2e/seeded-tiebreak.spec.ts` requires a working Docker daemon and the
`postgres:17-alpine` and `valkey/valkey:8-alpine` images. It creates temporary
containers on random loopback ports, applies the canonical schema, and copies
only the test suite's seeded card catalog. The replay preload blocks the upstream
card API so background seeding cannot change that catalog. Its two production server replays
own this storage, so their boot recovery cannot race the main browser suite.
The fixture removes its containers after success or setup/server failure;
unavailable Docker produces an actionable failure rather than skipping coverage.

Docker commands have bounded deadlines (30 seconds for creation, 10 seconds
for port lookup and cleanup). Cleanup errors name the exact owned containers
for a later retry; the fixture kills pending CLI processes when its worker exits.
Disposable PostgreSQL data uses tmpfs to reduce disk contention.

## Reviewed schema deployment

Ordinary app startup checks migration history and schema compatibility, then listens. It never applies DDL. An empty, pending, altered, newer or drifted database fails startup. `db:push` remains available for throwaway local experiments only.

Before deployment, review the SQL and manifest in `drizzle/`, stop app writers (including background jobs), and create a database backup with `pg_dump`. Test restoring that backup into a separate database before proceeding. Build the intended image, then run the explicit step:

```sh
docker compose build app
docker compose run --rm --no-deps app pnpm db:migrate
docker compose run --rm --no-deps app pnpm db:check
docker compose up -d app
```

For an existing database created with `db:push`, run `pnpm db:baseline` from the intended image before the migration step. Adoption verifies the entire public schema against the reviewed baseline before recording it; it preserves existing data and refuses drift. Do not bypass a mismatch: investigate the diff against a restored disposable copy and review a reconciliation before trying again. A clean install uses `db:migrate`. Existing versioned installs use `db:migrate` too.

Each deployment applies all pending SQL and journal entries in one transaction under a PostgreSQL advisory lock. Failure rolls back both schema/data changes and journal entries. Migrations must be transaction-compatible SQL (no concurrent index creation or explicit transaction control). Do not assume an old image can run against a new schema: checks require an exact version. For recovery, keep writers stopped, restore the verified pre-deploy dump into a fresh database with `psql -v ON_ERROR_STOP=1`, point the previous image at the restored database, run its `db:check`, and resume it. Keep the failed database for diagnosis.

To add a migration, edit `src/db/schema.ts`, run `pnpm db:generate --name <change>`, and review the generated SQL and Drizzle snapshot. Restore the current version into a disposable database and apply the candidate SQL there. Run `pnpm db:signature` against that database to obtain its resulting catalog signature, and append `{ "file": "<generated>.sql", "sha256": "<sha256sum of SQL>", "schema": "<signature>" }` to `drizzle/manifest.json`. Never edit previously released SQL or manifest entries. Rehearse clean install, upgrade with retained data, and failure/restore, then commit SQL, snapshots and manifest together. The manifest is the runtime authority; Drizzle metadata supports subsequent generation. Signatures cover public table columns/defaults/nullability, constraints, indexes and enum values; migrations own that schema.

The disposable integration drill runs with `CAB_MIGRATION_TEST_URL=postgres://cab_test:cab_test_only@127.0.0.1:55432/cab_audit_issue52_clean pnpm test:migrations`. It requires the dedicated audit PostgreSQL container and destroys only the explicitly named test database's schema.

## Database storage and disaster recovery

The checked-in PostgreSQL volume uses deployment-specific SMB/CIFS storage; its durability is unverified. See [storage assessment, supported local-volume configuration, reversible cutover and recovery drill](docs/operations/database-recovery.md) before changing volumes. Run `pnpm test:storage` for the isolated Docker crash/backup/restore drill.

Rich previews and public HTTPS origin configuration: [share preview deployment guide](docs/operations/share-previews.md).
