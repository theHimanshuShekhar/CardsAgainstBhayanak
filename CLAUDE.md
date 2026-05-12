# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Pre-implementation.** Only the design spec and reference materials exist — no source code, no `package.json`, no Dockerfile yet. Implementation has not started. When code work begins, scaffold from the spec; do not improvise architecture.

## Source of truth

Two documents drive all implementation decisions. Read both before touching code:

1. **`docs/superpowers/specs/2026-05-12-cards-against-bhayanak-design.md`** — the canonical spec. Covers tech stack, auth, HTTP/WS protocols, all types, game rules engine, database/Redis schemas, deployment, logging, PostHog integration, and the E2E test matrix. ~1100 lines. **The spec is law** — if you find yourself making an architectural decision that isn't in the spec, stop and ask the user rather than improvising.

2. **`docs/design-reference/`** — the original Claude Design HTML prototype (handoff bundle). Use for pixel-perfect UI implementation reference:
   - `project/Cards Against Bhayanak.html` — entry point
   - `project/styles.css` + `scenes.css` + `stats.css` — design tokens and component styling, to be ported to `src/styles.css`
   - `project/screens.jsx` — React component logic to port (vanilla React → TanStack Start routes)
   - `project/content.js` — placeholder card content (will be replaced by REST Against Humanity API data)
   - **Do NOT implement** `tweaks-panel.jsx` or `app.jsx`'s `TweaksPanel` block — these are design-tool meta-UI, not part of the real app.

## What the project is

A real-time multiplayer Cards Against Humanity clone. Players join via 6-character room codes (Jackbox-style — no accounts). Rotating Card Czar, original CAH gameplay, with all 8 official house rules from the 2014 rulebook. Strict monochrome B&W visual design.

## Tech stack (locked)

- **Framework:** TanStack Start (React 19, SSR, file-based routing) on Vinxi/h3
- **Styling:** Tailwind CSS v4 via `@theme` block in `src/styles.css` — no `tailwind.config.ts`
- **DB:** PostgreSQL via Drizzle ORM (`pnpm db:push` — no generated migrations)
- **Cache + pub/sub:** Redis (Valkey image, AOF persistence)
- **Real-time:** Native WebSocket via h3's `crossws`, same port as HTTP
- **Tests:** Playwright E2E, multi-context, real DB + Redis (no mocks)
- **Observability:** Pino → Axiom (logs), PostHog Cloud (analytics + session replay + error tracking)
- **Deployment:** Docker Compose + user-managed Cloudflare Tunnel (tunnel is not in compose)
- **Card data:** seeded at server start from `https://restagainsthumanity.com/api/v2/`

Don't substitute equivalents (e.g., don't propose Next.js, don't add Tanstack Query unless the spec calls for it). If you think a stack change is needed, ask first.

## Architectural pillars to internalise

These are the non-obvious decisions that span multiple files. Read the spec section in parentheses for full detail.

- **Two-stage auth** (Authentication section): HTTP `POST /api/games/$code/join` returns a `sessionToken` and `playerId`. WebSocket connects separately and sends `{ type: "auth", sessionToken }` as its first message. Reconnect uses the same token until the room's 24h Redis TTL expires.

- **Server-controlled phase timing** (Game Session screen, WS Protocol): Clients never run their own phase timers. The server schedules transitions and emits events at the right moment. Animations are CSS-only and react to received events.

- **Room termination is uniform across modes** (Game Rules Engine): Every mode — normal, God Is Dead, Survival, Serious Business — emits `round_end` with `handsRefilled` after its mode-specific resolution event (`round_won` / `round_ranked`). One code path handles hand replenishment.

- **Submission privacy** (WS Protocol): Server pre-shuffles inter-player submission order and hides `submissionId → playerId` mapping until reveal. The Czar cannot infer submitters by index. Order *within* a player's multi-card submission is preserved.

- **Stable czarOrder** (Game Rules Engine): Rotation traverses a fixed list in Redis (`game:{code}:czarOrder`), not a live-computed array. Dropped players stay in the list (skipped), so other players' rotation positions don't shift unexpectedly.

- **Modal vs orthogonal house rules** (Type Definitions, Create Game screen): `ModalRuleId` (godmode/survival/serious_business) are mutually exclusive — UI uses a radio group. `OrthogonalRuleId` (rebooting, packing_heat, rando, never_have_i_ever, happy_ending) stack freely.

- **Rando is a real DB row** (Database Schema, Rando section): When the `rando` house rule is on, server inserts a `game_players` row with `is_rando = true`. Scoring, winning, and stats queries all treat Rando like any other player — no special-case branches.

- **Seedable RNG via `src/lib/rng.ts`** (Randomness section): All non-crypto randomness routes through `seedrandom`-backed helpers. `CAB_RNG_SEED` env var makes tests fully deterministic. Crypto randomness (room codes, sessionToken HMAC) uses Node `crypto` directly — never the wrapper.

- **PostHog distinct_id = `anonId`** (PostHog section): Client generates a stable browser UUID stored in `localStorage.cab_anon_id`. Sent in HTTP join/create bodies and persisted on `game_players.posthog_anon_id`. Server-side events use the same ID. PostHog key is delivered to the client via `GET /api/config` at runtime — never bundled into the Vite build.

- **Privacy masking for session replay** (PostHog section): All card content elements (`.card-text`, `.card-back-mark`) carry `data-ph-no-capture`. CAH content is crude — never recorded.

## File layout (target — does not exist yet)

The spec's "Project File Structure" section is authoritative. Highlights:

- `src/routes/` — file-based routes including `api/` server routes
- `src/components/{ui,game}/` — semantic CSS class names, not Tailwind utility soup
- `src/lib/` — `game-engine.ts` (rules), `game-state.ts` (Redis), `game-event-handler.ts` (orchestration), `rng.ts`, `seed.ts`, `sweeper.ts`, `session-token.ts`, `code-gen.ts`, `rate-limit.ts`, `logger.ts`, `posthog-{client,server}.ts`, `types.ts`
- `src/ws/handler.ts` — h3 WebSocket route handler
- `src/db/schema.ts` — Drizzle schema (cuid2 IDs, no migrations)
- `src/styles.css` — single CSS file: Tailwind v4 `@theme` + design tokens (ported from `docs/design-reference/`) + game-specific class definitions
- `tests/e2e/` — Playwright specs, run against real Postgres + Redis test instances

## Commands (target — will exist once `package.json` is created)

Per the spec's Quick Reference section:

| Command | Purpose |
|---|---|
| `pnpm dev` | Dev server with HMR at http://localhost:3000 |
| `pnpm build` | Production build to `.output/` |
| `pnpm db:push` | Apply Drizzle schema to Postgres (no migrations, dev or prod) |
| `pnpm db:studio` | Drizzle Studio (DB browser) |
| `pnpm seed` | Manually trigger card pack seeding from REST AH |
| `pnpm test:e2e` | Playwright suite (requires Postgres + Redis up) |
| `pnpm test:e2e:ui` | Playwright UI mode |
| `docker compose up -d postgres redis` | Just deps for local dev |

## Working with the spec

- The spec has been through multiple deep reviews — internal contradictions have been hunted down. If you find one anyway, fix it in the spec first, then implement consistently.
- Implementation has not started; there's no plan document yet. The next step after the spec is to invoke the `writing-plans` skill to break it into an execution plan.
- Several decisions in the spec are explicitly marked as "MVP tradeoffs" (e.g. `pnpm db:push` in prod, accepting token replay risk). Don't try to "improve" these without checking — they were deliberate.

## Memory

Auto-memory lives in `/home/hshekhar/.claude/projects/-home-hshekhar-code-CardsAgainstBhayanak/memory/`. The existing `project_overview.md` was written before the current spec and predates many architectural decisions — trust the spec over the memory if they disagree.
