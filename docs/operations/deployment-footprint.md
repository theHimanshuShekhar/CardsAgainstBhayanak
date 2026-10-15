# Deployment and cold client footprint

Issue #56 measures a local baseline before removing development tooling from the runtime image. These measurements describe the environment below; they are not production performance targets or evidence of a historical regression.

## Environment and method

- Baseline: `4e80737` (the exact parent of the #56 change), built with its unchanged Dockerfile and frozen lockfile. Candidate: the #56 Dockerfile/package change on that parent; no application source or dependency versions changed.
- Linux x86-64, AMD Ryzen 7 5700G (16 logical CPUs), 16 GiB RAM, Docker 29.9.0 with overlayfs. Builds may share the host with other work; elapsed build/navigation times are observations, not controlled benchmarks.
- Both builds resolve `node:22-alpine` to `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`; pnpm 10.33.0. No analytics/sourcemap credentials are configured.
- Application environment: `NODE_ENV=production`, `PUBLIC_SITE_URL=https://cards.example.test`, `CAB_RNG_SEED=test-seed-2026`, `CAB_ROUND_RESULT_PAUSE_MS=2000`, and an explicitly disposable session secret.
- Disposable PostgreSQL 16.15 (`postgres:16-alpine`) and Valkey 8.1.10 (`valkey/valkey:8-alpine`) containers on an owned network; PostgreSQL uses ephemeral tmpfs storage. Application ports are assigned randomly on host loopback. None of the shared development databases/caches are used.
- Image size is the local daemon's `docker image inspect` reported `Size`, not registry download size, incremental disk use, or process RSS. Directory sizes use `du -sk` (KiB allocated); package counts are package directories directly inside `node_modules/.pnpm`, excluding its `node_modules` directory.
- Browser: Playwright 1.60.0, Chromium 148.0.7778.96, default desktop viewport, no CPU/network throttling. Three independent cold contexts per route, HTTP direct to the production entry on loopback, service workers blocked, CDP cache disabled. The server is already running and schema/cards are ready: “cold” describes the browser cache, not process startup or OS disk cache.
- The helper waits for network idle and font readiness. It reports CDP `Network.loadingFinished.encodedDataLength` (received bytes including response headers), separately for first-party requests, `/assets/`, and external requests. It also records failures, page errors, response encodings and per-request details. External Google Fonts requests and analytics configuration can change real-user totals. These direct-origin responses do not include tunnel/CDN compression.

## Runtime boundary

The previous final stage copied the full build `node_modules`. A separate frozen `--prod` install now supplies that directory. `tsx` moves to `dependencies`: `pnpm start`, migration/check/baseline/signature scripts and the seed CLI execute TypeScript at runtime. `--ignore-scripts` avoids the development-only Husky prepare hook; the retained platform-specific esbuild package is exercised by actual startup and CLI smokes.

ESLint, Vitest/coverage, Playwright, Prettier, Husky/lint-staged, Tailwind tooling and `drizzle-kit` are development tools. They are no longer direct runtime installs. Schema application/adoption/checking uses the reviewed `scripts/migrate.ts` and `postgres`, not `drizzle-kit`. The runtime still contains the migration SQL/manifest, source, tsconfig, seed and deployment scripts. Generation, studio and legacy push commands require a checkout with development dependencies.

Keep TanStack runtime dependencies and their transitive graph: SSR imports them. Production-only installation does not imply every transitive build tool disappears; report the resulting graph rather than deleting packages by name. `pino-pretty` remains available for supported non-production logging modes.

## Measured results — 16 October 2026 (Asia/Kolkata)

| Runtime measurement               |    Baseline |   Candidate |                Change |
| --------------------------------- | ----------: | ----------: | --------------------: |
| Docker reported image size, bytes | 658,981,531 | 520,444,088 | −138,537,443 (−21.0%) |
| `node_modules`, KiB allocated     |     343,980 |     232,828 |     −111,152 (−32.3%) |
| Installed package directories     |         434 |         259 |                  −175 |
| `dist`, KiB allocated             |       1,256 |       1,256 |                     0 |
| `src`, KiB allocated              |         812 |         812 |                     0 |
| `drizzle`, KiB allocated          |         112 |         112 |                     0 |
| `scripts`, KiB allocated          |          16 |          16 |                     0 |

Image IDs returned by the local daemon:

- Baseline: `sha256:765c4a51e603655304c3108b710f3bfe2e14cdb4ed03b8b5fc825933ee8032d8`.
- Candidate: `sha256:d230be80bc0a731a9fed573d19e4a666a7efcf517e01092c22a82c96dde22922`.

Both images run Node 22.23.3. Every retained package directory matches the baseline graph: 175 removed, zero added. Removed packages include TypeScript (22,272 KiB), Playwright core (12,356 KiB), Drizzle Kit (9,960 KiB), ESLint and Vitest. The largest retained package is `posthog-js` (35,152 KiB); `drizzle-orm` (16,240 KiB), core-js (~15,776 KiB), esbuild (~10,892 KiB), Lightning CSS (9,840 KiB) and transitive Prettier (8,564 KiB) remain. Runtime `.bin` contains `cuid2`, `h3`, `pino`, `pino-pretty`, `srvx`, and `tsx`.

All 18 emitted client assets have identical SHA-256 hashes and sizes in both images (687,975 bytes total on disk). Each route's three completed samples returned HTTP 200 with zero failed requests and zero browser page errors. The catalog was fully seeded before these runs: 72 packs, 1,038 black cards, 4,655 white cards, and no matches. An earlier exploratory run during seeding had changing pack responses and two external font network failures; it is excluded from this comparison.

| Cold route      | First-party requests, before/after | `/assets/` transferred bytes, before/after | All first-party transferred bytes, before/after | External font bytes, before/after |
| --------------- | ---------------------------------: | -----------------------------------------: | ----------------------------------------------: | --------------------------------: |
| `/`             |                              7 / 7 |                          568,161 / 568,161 |                               575,455 / 575,455 |            54,754 / 54,755–54,756 |
| `/games/create` |                            10 / 10 |                          643,862 / 643,862 |                               666,530 / 666,530 |                   54,756 / 54,755 |
| `/stats`        |                              7 / 7 |                          570,602 / 570,602 |                               576,672 / 576,672 |     54,755–54,756 / 54,755–54,756 |

Median DOMContentLoaded / load event timings in milliseconds were: home 215.2 / 373.5 → 211.2 / 346.1; create 184.4 / 366.5 → 208.6 / 378.5; stats 210.4 / 377.7 → 189.1 / 333.8. Three unthrottled samples with live external fonts and shared-host activity cannot establish a speed improvement or regression. The evidenced browser result is unchanged client assets and first-party transfer sizes. Direct-origin assets have no `Content-Encoding`; Vite's printed gzip estimate is not the transferred size here.

The [measurement data](footprint-2026-10-16.json) retains every reported sample, image/directory measurements and the matching client asset hashes. Detailed per-request output can be regenerated with the helper below.

## Validation

The candidate was built through the complete Dockerfile and started with its normal command as `cab`, under `NODE_ENV=production`. `/api/healthz` returned HTTP 200 with PostgreSQL/Redis healthy and recovery ready. `/`, `/games/create` and `/stats` returned server-rendered HTML with scripts; all three also loaded and hydrated during the cold-browser measurements.

Actual candidate-image CLI checks covered a clean `db:migrate`/`db:check`/`db:signature`, and an unversioned `0000` schema followed by `db:baseline`, upgrade through `0003`, check and signature. Both paths produced `414ca6260977b31d25c750ee93b390c1bda1353d675b6fcd5da896d284a46830`. `pnpm seed` completed against the live card API. Optional Axiom and server PostHog modules imported successfully; external analytics ingestion was not configured.

The existing `full-game.spec.ts` normal-mode round and completed-match/rematch protocol tests both passed against a fresh candidate production process (2 tests, 42.2 seconds). They exercise authenticated WebSockets, reveal, winner resolution, round advancement and match reset. Typecheck, lint and changed-file formatting checks passed.

The original `ui-golden-path.spec.ts` timed out at its next-round assertion against both unchanged images (candidate 33.9 seconds; baseline 35.4 seconds). A targeted browser WebSocket probe confirmed that its helper sent `pick` after only one of two expected `card_revealed` events and received `invalid_state`; a second candidate run reproduced that rejection. The fixture correction waits for the expected number of face-up, clickable cards rather than sleeping after the first reveal. It is a separate commit; application/gameplay code is unchanged. With the corrected fixture, both unchanged images passed the three-browser create/join/play/win/rematch test (one test against each image). Temporary diagnostic probes were removed.

## Reproduce

Build the baseline from its own detached checkout and the candidate from the intended commit; do not reuse a moving `main` as the baseline:

```sh
git worktree add --detach /tmp/cab-footprint-before 4e80737
docker build -t cab-footprint:before /tmp/cab-footprint-before
docker build -t cab-footprint:after .

docker image inspect cab-footprint:before cab-footprint:after \
  --format '{{.Id}} {{.Size}}'
docker run --rm --entrypoint sh cab-footprint:after -c \
  'node --version; pnpm --version; du -sk /app/node_modules /app/dist /app/src /app/drizzle /app/scripts; ls /app/node_modules/.bin; du -sk /app/node_modules/.pnpm/* | sort -nr | head -20'
```

The Node image tag can move. To repeat this environment later, substitute the recorded `node:22-alpine@sha256:…` reference for every `node:22-alpine` in temporary copies of both Dockerfiles and pass each copy with `docker build -f`. Compare both on the same host/base image and catalog; the live card API and fonts are not immutable fixtures.

Use dedicated disposable storage and the documented versioned migration workflow. For each image, supply `DATABASE_URL`, `REDIS_URL`, a disposable 32+ character `SESSION_SECRET`, and `PUBLIC_SITE_URL` in its environment. Run `pnpm db:migrate`, `pnpm db:check` and `pnpm seed` from that image before starting its normal command. Publish its port with `-p 127.0.0.1::3000`; `docker port <container> 3000/tcp` returns the assigned address. Do not point E2E teardown at shared or production storage.

From a development checkout (the helper is deliberately excluded from the image):

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
node docs/operations/measure-client-load.mjs http://127.0.0.1:<assigned-port> / /games/create /stats > /tmp/client-load.jsonl
```

Record the image IDs, resolved base digest, versions, seed/catalog state, route request counts/bytes, timings and any failures for both runs. Compare completed samples with identical external-resource conditions. Use `CAB_E2E_BASE` and the same owned `DATABASE_URL`/`REDIS_URL` to run the existing `tests/e2e/ui-golden-path.spec.ts` against the image; that exercises three browser contexts creating/joining, authenticated sockets, gameplay, a completed match and rematch. Keep production startup/check failures visible instead of automatically applying migrations at boot.
