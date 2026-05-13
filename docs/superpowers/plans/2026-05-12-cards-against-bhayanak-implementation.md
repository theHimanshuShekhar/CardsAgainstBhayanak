# Cards Against Bhayanak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real-time multiplayer Cards Against Bhayanak game end-to-end per `SPEC.md`, from empty repo to deployable Docker stack with full E2E test coverage.

**Architecture:** TanStack Start monorepo (React 19 SSR + Vinxi/h3) hosts both the UI and a same-port WebSocket server. Game logic and state live in Postgres (Drizzle ORM, no migrations) plus Redis (Valkey, pub/sub + AOF). Frontend is built first against stubbed data; backend (WS handler + game engine) is wired in after. PostHog Cloud captures analytics, session replay, and errors. Deployment via Docker Compose; user runs Cloudflare Tunnel separately.

**Tech Stack:** TanStack Start, React 19, Tailwind CSS v4, TypeScript strict, Drizzle ORM, PostgreSQL 16, Valkey 8, Pino + Axiom, posthog-js + posthog-node, seedrandom, node-cron, Playwright, pnpm 9, Docker Compose.

**Reading order before starting:** `SPEC.md` (canonical), `CLAUDE.md` (distilled summary), `docs/design-reference/project/styles.css` + `screens.jsx` (pixel-perfect UI source).

---

## Conventions used throughout this plan

- **Commits are frequent and atomic.** Each task ends with a commit. Never batch unrelated changes.
- **TDD where the unit is testable**: pure logic (rules engine, RNG, code-gen, session-token, game-state ops) gets unit tests first. UI components and WS integration get Playwright E2E. Stub data is used during the frontend-first phase; we don't write integration tests against stubs.
- **No `any` types.** Strict TypeScript. Inferred types preferred.
- **Imports use `~/` alias for `src/`** (configured in Phase 0).
- **Pre-commit hook runs `pnpm typecheck && pnpm lint`** (configured in Phase 0). Don't bypass with `--no-verify`.
- **Commit message style:** Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`). Keep first line under 70 chars.
- **`docs/design-reference/` is read-only** — port from it, don't modify it.

---

## Phase 0 — Project Scaffolding

### Task 0.1: Initialize pnpm project and core dependencies — ✅ DONE

**Files:**

- Create: `package.json`
- Create: `.gitignore`
- Create: `.nvmrc`

- [x] **Step 1: Create `.nvmrc`**

```
22
```

- [x] **Step 2: Create `.gitignore`**

```
node_modules
.output
.vinxi
.turbo
dist
build
*.log
.env
.env.local
.env.*.local
!.env.example
coverage
playwright-report
test-results
.DS_Store
```

- [x] **Step 3: Initialize package.json**

Run:

```bash
pnpm init
```

Then edit `package.json` to:

```json
{
  "name": "cards-against-bhayanak",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "dev": "vinxi dev",
    "build": "vinxi build",
    "start": "vinxi start",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings 0",
    "format": "prettier --write .",
    "db:push": "drizzle-kit push",
    "db:studio": "drizzle-kit studio",
    "seed": "tsx src/lib/seed.ts",
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "prepare": "husky"
  }
}
```

- [x] **Step 4: Install runtime dependencies**

Run:

```bash
pnpm add @tanstack/react-router @tanstack/react-start @tanstack/start vinxi h3 crossws \
  react@^19 react-dom@^19 \
  drizzle-orm postgres @paralleldrive/cuid2 \
  ioredis \
  jose bcryptjs \
  zod \
  pino @axiomhq/pino pino-pretty \
  posthog-js posthog-node \
  seedrandom \
  node-cron
```

- [x] **Step 5: Install dev dependencies**

Run:

```bash
pnpm add -D typescript@~5.6 @types/node@^22 @types/react@^19 @types/react-dom@^19 \
  @types/seedrandom @types/node-cron @types/bcryptjs \
  tsx \
  drizzle-kit \
  @tailwindcss/vite tailwindcss@^4 \
  @playwright/test \
  eslint @eslint/js typescript-eslint eslint-plugin-react-hooks eslint-plugin-react-refresh \
  prettier \
  husky lint-staged
```

- [x] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .nvmrc .gitignore
git commit -m "chore: scaffold pnpm project with core dependencies"
```

### Task 0.2: Configure TypeScript — ✅ DONE

**Files:**

- Create: `tsconfig.json`

- [x] **Step 1: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2023"],
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "baseUrl": ".",
    "paths": {
      "~/*": ["src/*"]
    }
  },
  "include": [
    "src/**/*",
    "tests/**/*",
    "app.config.ts",
    "drizzle.config.ts",
    "playwright.config.ts"
  ]
}
```

- [x] **Step 2: Verify TypeScript installs and runs**

Run:

```bash
pnpm typecheck
```

Expected: passes (no files yet, no errors).

- [x] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore: configure TypeScript strict mode with ~/ alias"
```

### Task 0.3: Configure TanStack Start + Vinxi — ✅ DONE

**Files:**

- Create: `app.config.ts`
- Create: `src/router.tsx`
- Create: `src/client.tsx`
- Create: `src/ssr.tsx`
- Create: `src/routes/__root.tsx`
- Create: `src/routes/index.tsx` (placeholder)
- Create: `src/routeTree.gen.ts` (will be auto-generated; create empty file as placeholder)

- [x] **Step 1: Create `app.config.ts`**

```ts
import { defineConfig } from '@tanstack/start/config'
import tsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  vite: {
    plugins: [tsConfigPaths({ projects: ['./tsconfig.json'] }), tailwindcss()],
  },
})
```

- [x] **Step 2: Install `vite-tsconfig-paths`**

```bash
pnpm add -D vite-tsconfig-paths
```

- [x] **Step 3: Create `src/router.tsx`**

```tsx
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
```

- [x] **Step 4: Create `src/client.tsx`**

```tsx
import { hydrateRoot } from 'react-dom/client'
import { StartClient } from '@tanstack/start'
import { createRouter } from './router'

const router = createRouter()
hydrateRoot(document, <StartClient router={router} />)
```

- [x] **Step 5: Create `src/ssr.tsx`**

```tsx
import { createStartHandler, defaultStreamHandler } from '@tanstack/start/server'
import { getRouterManifest } from '@tanstack/start/router-manifest'
import { createRouter } from './router'

export default createStartHandler({
  createRouter,
  getRouterManifest,
})(defaultStreamHandler)
```

- [x] **Step 6: Create `src/routes/__root.tsx`**

```tsx
import { Outlet, ScrollRestoration, createRootRoute } from '@tanstack/react-router'
import { Meta, Scripts } from '@tanstack/start'
import type { ReactNode } from 'react'
import '~/styles.css'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Cards Against Bhayanak' },
    ],
    links: [
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: '' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800;900&family=Geist+Mono:wght@400;500;600&family=Bricolage+Grotesque:wght@500;700;800;900&display=swap',
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Meta />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}
```

- [x] **Step 7: Create placeholder `src/routes/index.tsx`**

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: () => <div>Hello CAB</div>,
})
```

- [x] **Step 8: Run dev server to trigger route tree generation**

```bash
pnpm dev
```

Wait until the dev server logs "Local: http://localhost:3000". `src/routeTree.gen.ts` will be auto-generated. Stop the dev server (Ctrl+C).

- [x] **Step 9: Visit http://localhost:3000 and verify "Hello CAB" renders**

- [x] **Step 10: Commit**

```bash
git add app.config.ts src/router.tsx src/client.tsx src/ssr.tsx src/routes/__root.tsx src/routes/index.tsx src/routeTree.gen.ts package.json pnpm-lock.yaml
git commit -m "chore: configure TanStack Start with root layout"
```

### Task 0.4: Configure Tailwind v4 + design tokens — ✅ DONE

**Files:**

- Create: `src/styles.css`

- [x] **Step 1: Create `src/styles.css` by porting design tokens from `docs/design-reference/project/styles.css`**

Source the values verbatim from the design reference; do not paraphrase. The file should start with:

```css
@import 'tailwindcss';

@theme {
  --color-black: #000000;
  --color-black-2: #0a0a0a;
  --color-black-3: #141414;
  --color-ink: #1a1a1a;
  --color-ink-2: #242424;
  --color-white: #ffffff;
  --color-white-2: #f7f7f5;
  --color-paper: #ffffff;
  --color-gray-1: #e7e7e5;
  --color-gray-2: #c8c8c4;
  --color-gray-3: #8a8a86;
  --color-gray-4: #5a5a56;
  --color-gray-5: #2e2e2c;

  --font-display: 'Geist', 'Bricolage Grotesque', system-ui, sans-serif;
  --font-body: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;

  --radius-sm: 6px;
  --radius: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
}

:root {
  --hairline: rgba(255, 255, 255, 0.1);
  --hairline-2: rgba(255, 255, 255, 0.2);
  --hairline-3: rgba(255, 255, 255, 0.34);
  --shadow-card:
    0 1px 0 rgba(255, 255, 255, 0.06) inset, 0 18px 36px -18px rgba(0, 0, 0, 0.85),
    0 2px 4px rgba(0, 0, 0, 0.4);
  --shadow-paper:
    0 1px 0 rgba(0, 0, 0, 0.04) inset, 0 18px 36px -18px rgba(0, 0, 0, 0.55),
    0 2px 6px rgba(0, 0, 0, 0.25);
}

* {
  box-sizing: border-box;
}
html,
body,
#root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--color-black);
  color: var(--color-white);
  font-family: var(--font-body);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow: hidden;
  overscroll-behavior: none;
}

button {
  font-family: inherit;
}
```

Then append the rest of the design's `styles.css`, `scenes.css`, and `stats.css` content (component classes: `.btn`, `.card`, `.sheet`, `.scoreboard`, `.hand-dock`, etc.) verbatim, replacing the design's CSS variable references (`var(--black)`) with the Tailwind v4 prefixed names (`var(--color-black)`) where the variable was moved into `@theme`.

- [x] **Step 2: Update `src/routes/index.tsx` to test fonts and tokens**

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: () => (
    <div style={{ padding: 40 }}>
      <h1 style={{ font: '900 48px/1 var(--font-display)' }}>Cards Against Bhayanak</h1>
      <button className="btn btn-primary btn-lg">Test button</button>
    </div>
  ),
})
```

- [x] **Step 3: Run dev server and verify Geist font + monochrome button render**

```bash
pnpm dev
```

Open http://localhost:3000. Header should be in Geist black-on-black-bg. Button should be white-on-black per design.

- [x] **Step 4: Commit**

```bash
git add src/styles.css src/routes/index.tsx
git commit -m "feat: port design tokens and component CSS from design reference"
```

### Task 0.5: Configure ESLint + Prettier + Husky — ✅ DONE

**Files:**

- Create: `eslint.config.js`
- Create: `.prettierrc`
- Create: `.husky/pre-commit`
- Modify: `package.json` (add `lint-staged` config)

- [x] **Step 1: Create `eslint.config.js`**

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  { ignores: ['.output', '.vinxi', 'node_modules', 'src/routeTree.gen.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
)
```

- [x] **Step 2: Create `.prettierrc`**

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [x] **Step 3: Initialize husky**

```bash
pnpm exec husky init
```

- [x] **Step 4: Replace `.husky/pre-commit` content**

```bash
pnpm lint-staged
```

- [x] **Step 5: Add lint-staged config to `package.json`**

```json
"lint-staged": {
  "*.{ts,tsx}": ["eslint --fix --max-warnings 0", "prettier --write"],
  "*.{json,md,css}": ["prettier --write"]
}
```

- [x] **Step 6: Run lint to verify it works**

```bash
pnpm lint
```

Expected: passes.

- [x] **Step 7: Commit**

```bash
git add eslint.config.js .prettierrc .husky package.json pnpm-lock.yaml
git commit -m "chore: configure eslint, prettier, husky pre-commit"
```

### Task 0.6: Configure Drizzle + Postgres connection — ✅ DONE

**Files:**

- Create: `drizzle.config.ts`
- Create: `src/db/index.ts`
- Create: `src/db/schema.ts` (skeleton)
- Create: `.env.example`

- [x] **Step 1: Create `.env.example`**

```
DATABASE_URL=postgres://cab:cab@localhost:5432/cab_dev
REDIS_URL=redis://localhost:6379/0
SESSION_SECRET=dev-secret-change-me-min-32-chars-long
PORT=3000
NODE_ENV=development

# Optional in dev
AXIOM_TOKEN=
AXIOM_DATASET=cab-dev
POSTHOG_API_KEY=
POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_PERSONAL_API_KEY=

# Tests only
CAB_RNG_SEED=test-seed-2026
```

- [x] **Step 2: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
})
```

- [x] **Step 3: Create `src/db/index.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL not set')

const client = postgres(url, { max: 10 })
export const db = drizzle(client, { schema })
export type DB = typeof db
```

- [x] **Step 4: Create `src/db/schema.ts` skeleton**

```ts
// Schema will be filled in Phase 3.
export {}
```

- [x] **Step 5: Commit**

```bash
git add drizzle.config.ts src/db/ .env.example
git commit -m "chore: configure Drizzle with Postgres connection"
```

### Task 0.7: Create local docker-compose for dev dependencies — ✅ DONE

**Files:**

- Create: `docker-compose.yml`

- [x] **Step 1: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: cab_postgres
    environment:
      POSTGRES_USER: cab
      POSTGRES_PASSWORD: cab
      POSTGRES_DB: cab_dev
    ports:
      - '127.0.0.1:5432:5432'
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U cab -d cab_dev']
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: valkey/valkey:8-alpine
    container_name: cab_redis
    command: ['valkey-server', '--appendonly', 'yes']
    ports:
      - '127.0.0.1:6379:6379'
    volumes:
      - redis_data:/data
    healthcheck:
      test: ['CMD', 'valkey-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  postgres_data:
  redis_data:
```

- [x] **Step 2: Start the services**

```bash
docker compose up -d postgres redis
docker compose ps
```

Expected: both services show `(healthy)` within ~10s.

- [x] **Step 3: Verify Postgres connection**

```bash
docker exec cab_postgres psql -U cab -d cab_dev -c "SELECT 1;"
```

Expected: returns `1`.

- [x] **Step 4: Verify Redis connection**

```bash
docker exec cab_redis valkey-cli PING
```

Expected: `PONG`.

- [x] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "chore: add docker-compose for local postgres and valkey"
```

### Task 0.8: Configure Playwright — ✅ DONE

**Files:**

- Create: `playwright.config.ts`
- Create: `tests/e2e/.gitkeep`

- [x] **Step 1: Install Playwright browsers**

```bash
pnpm exec playwright install --with-deps chromium
```

- [x] **Step 2: Create `playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000',
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: 'postgres://cab:cab@localhost:5432/cab_test',
      REDIS_URL: 'redis://localhost:6379/1',
      SESSION_SECRET: 'test-secret-min-32-chars-test-test-test',
      CAB_RNG_SEED: 'test-seed-2026',
      NODE_ENV: 'test',
    },
  },
})
```

- [x] **Step 3: Create `tests/e2e/.gitkeep`**

```

```

- [x] **Step 4: Create test database**

```bash
docker exec cab_postgres psql -U cab -d postgres -c "CREATE DATABASE cab_test;"
```

- [x] **Step 5: Commit**

```bash
git add playwright.config.ts tests/
git commit -m "chore: configure Playwright with chromium project and webServer"
```

---

## Phase 1 — Type Definitions

### Task 1.1: Define all shared types — ✅ DONE

**Files:**

- Create: `src/lib/types.ts`

- [x] **Step 1: Create `src/lib/types.ts` mirroring SPEC.md § Type Definitions verbatim**

```ts
// ── Player & role ─────────────────────────────────────────────
export type Role = 'player' | 'spectator'

export type PlayerStatus = 'active' | 'queued' | 'spectator' | 'grace' | 'dropped'

export type GamePlayer = {
  id: string
  username: string
  role: Role
  status: PlayerStatus
  score: number
  isHost: boolean
  isRando: boolean
  discardsUsed: number
  joinedAt: string
}

export type PlayerScore = {
  playerId: string
  username: string
  score: number
  isJudge: boolean
  isRando: boolean
}

// ── Cards ─────────────────────────────────────────────────────
export type Card = {
  id: string
  text: string
}

export type BlackCard = Card & { pick: 1 | 2 | 3 }

export type Hand = Card[]

// ── Submissions ───────────────────────────────────────────────
export type Submission = {
  submissionId: string
  fills: Card[]
  playerId?: string
  rank?: 1 | 2 | 3
  eliminated?: boolean
}

// ── Session-level status ──────────────────────────────────────
export type SessionStatus = 'lobby' | 'active' | 'paused' | 'ended' | 'abandoned'

// ── Phases ────────────────────────────────────────────────────
export type GamePhase =
  | 'picking'
  | 'waiting'
  | 'judging'
  | 'eliminating'
  | 'ranking'
  | 'reveal'
  | 'transition'

// ── House rule IDs ────────────────────────────────────────────
export type ModalRuleId = 'godmode' | 'survival' | 'serious_business'
export type OrthogonalRuleId =
  | 'rebooting'
  | 'packing_heat'
  | 'rando'
  | 'never_have_i_ever'
  | 'happy_ending'
export type RuleId = ModalRuleId | OrthogonalRuleId

// ── Session state ─────────────────────────────────────────────
export type SessionState = {
  phase: GamePhase
  round: number
  prompt: BlackCard
  czarId: string | null
  hand?: Hand
  submissions: Submission[]
  scores: PlayerScore[]
  revealIndex: number
  winnerId: string | null
  eliminationTurnPlayerId?: string
  voteTally?: Record<string, number>
  ranking?: Submission[]
}

// ── Game over outcomes ────────────────────────────────────────
export type GameOverMode = 'normal' | 'happy_ending' | 'rando_won' | 'deck_exhausted' | 'abandoned'

// ── Error codes ───────────────────────────────────────────────
export type ErrorCode =
  | 'not_authorized'
  | 'invalid_token'
  | 'player_dropped'
  | 'spectator_action'
  | 'invalid_state'
  | 'rate_limited'
  | 'room_full'
  | 'room_not_found'
  | 'duplicate_username'
  | 'conflicting_rules'
  | 'host_only'
  | 'score_too_low'
  | 'internal_error'

// ── Config ────────────────────────────────────────────────────
export type GameConfig = {
  maxPlayers: number
  roundsToWin: number
  timer: '30s' | '60s' | '90s' | 'Off'
  packs: string[]
  rules: RuleId[]
}

export type GameDraft = GameConfig & {
  username: string
  roomCode?: string
  playerId?: string
  role?: Role
}

// ── localStorage shape ────────────────────────────────────────
export type CabSession = {
  roomCode: string
  playerId: string
  sessionToken: string
  username: string
  role: Role
  anonId: string
}

// ── WS event union (for exhaustive switch) ────────────────────
export type ClientToServerEvent =
  | { type: 'auth'; sessionToken: string; anonId: string }
  | { type: 'rejoin' }
  | { type: 'play'; cardIds: string[] }
  | { type: 'gamble' }
  | { type: 'pick'; submissionId: string }
  | { type: 'rank'; ranking: string[] }
  | { type: 'vote'; submissionId: string }
  | { type: 'eliminate'; submissionId: string }
  | { type: 'redraw' }
  | { type: 'confess_discard'; cardId: string }
  | { type: 'leave' }
  | { type: 'ping' }

export type ServerToClientEvent =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; code: ErrorCode; message: string }
  | { type: 'state_snapshot'; state: SessionState }
  | { type: 'player_joined'; player: GamePlayer }
  | { type: 'player_left'; playerId: string }
  | { type: 'game_started'; firstRound: number }
  | { type: 'round_started'; round: number; prompt: BlackCard; czarId: string | null; hand?: Hand }
  | { type: 'player_played'; playerId: string }
  | { type: 'player_gambled'; playerId: string }
  | { type: 'player_skipped'; playerId: string; round: number }
  | { type: 'reveal_start' }
  | { type: 'card_revealed'; submissionIndex: number; fills: Card[] }
  | { type: 'round_won'; winnerId: string; submissionId: string; scores: PlayerScore[] }
  | { type: 'round_ranked'; ranking: Submission[]; scoresDelta: Record<string, number> }
  | { type: 'elimination_turn'; playerId: string }
  | { type: 'card_eliminated'; submissionId: string; byPlayerId: string }
  | { type: 'vote_tally'; votes: Record<string, number> }
  | { type: 'round_end'; activatedPlayers: string[]; handsRefilled: Record<string, Hand> }
  | { type: 'game_over'; finalScores: PlayerScore[]; winnerId: string; mode: GameOverMode }
  | { type: 'error'; code: ErrorCode; message: string }
  | { type: 'pong' }
```

- [x] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [x] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: define all shared TypeScript types from spec"
```

### Task 1.2: Define timing constants — ✅ DONE

**Files:**

- Create: `src/lib/timing.ts`

- [x] **Step 1: Create `src/lib/timing.ts`**

```ts
export const TIMING = {
  DEAL_MS: 550,
  FADE_IN_MS: 400,
  REVEAL_STAGGER: 700,
  WINNER_PAUSE: 2600,
  RECONNECT_TOAST: 250,
  GRACE_WINDOW_MS: 30_000,
  KEEPALIVE_INTERVAL_MS: 15_000,
  KEEPALIVE_TIMEOUT_MS: 45_000,
} as const
```

- [x] **Step 2: Commit**

```bash
git add src/lib/timing.ts
git commit -m "feat: add animation and lifecycle timing constants"
```

---

## Phase 2 — Pure Library Functions (TDD)

These pure functions have no I/O. Test-first with Vitest is appropriate; we'll add Vitest just for these.

### Task 2.1: Add Vitest — ✅ DONE

**Files:**

- Modify: `package.json` (add `test` script and Vitest dep)
- Create: `vitest.config.ts`

- [x] **Step 1: Install Vitest**

```bash
pnpm add -D vitest @vitest/coverage-v8
```

- [x] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [x] **Step 3: Add scripts to `package.json`**

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [x] **Step 4: Commit**

```bash
git add vitest.config.ts package.json pnpm-lock.yaml
git commit -m "chore: add Vitest for unit tests"
```

### Task 2.2: Seedable RNG wrapper — ✅ DONE

**Files:**

- Create: `src/lib/rng.ts`
- Create: `src/lib/rng.test.ts`

- [x] **Step 1: Write failing tests**

```ts
// src/lib/rng.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { seedRng, randomInt, shuffle, pick } from './rng'

describe('rng', () => {
  beforeEach(() => seedRng('test-seed'))

  it('randomInt produces values in [min, max)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomInt(5, 10)
      expect(v).toBeGreaterThanOrEqual(5)
      expect(v).toBeLessThan(10)
    }
  })

  it('same seed yields same sequence', () => {
    seedRng('abc')
    const a = [randomInt(0, 1000), randomInt(0, 1000), randomInt(0, 1000)]
    seedRng('abc')
    const b = [randomInt(0, 1000), randomInt(0, 1000), randomInt(0, 1000)]
    expect(a).toEqual(b)
  })

  it('shuffle returns a new array with the same elements', () => {
    const input = [1, 2, 3, 4, 5]
    const out = shuffle(input)
    expect(out).not.toBe(input)
    expect(out.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('shuffle is deterministic with same seed', () => {
    seedRng('shuf')
    const a = shuffle([1, 2, 3, 4, 5])
    seedRng('shuf')
    const b = shuffle([1, 2, 3, 4, 5])
    expect(a).toEqual(b)
  })

  it('pick returns one of the array elements', () => {
    const arr = ['a', 'b', 'c']
    for (let i = 0; i < 100; i++) expect(arr).toContain(pick(arr))
  })
})
```

- [x] **Step 2: Verify test fails**

```bash
pnpm test src/lib/rng.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/lib/rng.ts`**

```ts
import seedrandom from 'seedrandom'

let rng: seedrandom.PRNG = seedrandom(process.env.CAB_RNG_SEED ?? undefined)

export function seedRng(seed: string): void {
  rng = seedrandom(seed)
}

export function randomInt(min: number, max: number): number {
  if (max <= min) throw new Error('max must be > min')
  return Math.floor(rng() * (max - min)) + min
}

export function shuffle<T>(array: readonly T[]): T[] {
  const out = [...array]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

export function pick<T>(array: readonly T[]): T {
  if (array.length === 0) throw new Error('cannot pick from empty array')
  return array[randomInt(0, array.length)]!
}
```

- [x] **Step 4: Verify tests pass**

```bash
pnpm test src/lib/rng.test.ts
```

Expected: 5 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/lib/rng.ts src/lib/rng.test.ts
git commit -m "feat: add seedable PRNG via seedrandom"
```

### Task 2.3: Room code generation — ✅ DONE

**Files:**

- Create: `src/lib/code-gen.ts`
- Create: `src/lib/code-gen.test.ts`

- [x] **Step 1: Write failing tests**

```ts
// src/lib/code-gen.test.ts
import { describe, it, expect } from 'vitest'
import { generateRoomCode, formatRoomCode, normalizeRoomCode, ROOM_CODE_ALPHABET } from './code-gen'

describe('code-gen', () => {
  it('alphabet has 31 chars and excludes O, 0, I, 1, L', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(31)
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[O0I1L]/)
  })

  it('generateRoomCode produces 6 uppercase alphanumeric chars from the allowed alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode()
      expect(code).toHaveLength(6)
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch)
    }
  })

  it('formatRoomCode inserts a dash', () => {
    expect(formatRoomCode('B7K9MV')).toBe('B7K-9MV')
  })

  it('normalizeRoomCode strips dashes, spaces, and uppercases', () => {
    expect(normalizeRoomCode('b7k-9mv')).toBe('B7K9MV')
    expect(normalizeRoomCode('B7K 9MV')).toBe('B7K9MV')
    expect(normalizeRoomCode('B7K9MV')).toBe('B7K9MV')
  })
})
```

- [x] **Step 2: Verify test fails**

```bash
pnpm test src/lib/code-gen.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/lib/code-gen.ts`**

```ts
import { randomInt as cryptoRandomInt } from 'node:crypto'

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateRoomCode(): string {
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += ROOM_CODE_ALPHABET[cryptoRandomInt(0, ROOM_CODE_ALPHABET.length)]
  }
  return out
}

export function formatRoomCode(raw: string): string {
  if (raw.length !== 6) throw new Error('expected 6-char raw room code')
  return `${raw.slice(0, 3)}-${raw.slice(3)}`
}

export function normalizeRoomCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase()
}
```

- [x] **Step 4: Verify tests pass**

```bash
pnpm test src/lib/code-gen.test.ts
```

Expected: 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/lib/code-gen.ts src/lib/code-gen.test.ts
git commit -m "feat: add room code generation with rejection-sampling RNG"
```

### Task 2.4: Session token (HMAC sign/verify) — ✅ DONE

**Files:**

- Create: `src/lib/session-token.ts`
- Create: `src/lib/session-token.test.ts`

- [x] **Step 1: Write failing tests**

```ts
// src/lib/session-token.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { signSessionToken, verifySessionToken } from './session-token'

beforeAll(() => {
  process.env.SESSION_SECRET = 'test-secret-min-32-chars-long-enough!'
})

describe('session-token', () => {
  it('roundtrips player+room', async () => {
    const token = await signSessionToken({ playerId: 'p1', roomCode: 'B7K9MV' })
    const payload = await verifySessionToken(token)
    expect(payload).toMatchObject({ playerId: 'p1', roomCode: 'B7K9MV' })
  })

  it('rejects a tampered token', async () => {
    const token = await signSessionToken({ playerId: 'p1', roomCode: 'B7K9MV' })
    const tampered = token.slice(0, -2) + 'AA'
    await expect(verifySessionToken(tampered)).rejects.toThrow()
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signSessionToken({ playerId: 'p1', roomCode: 'B7K9MV' })
    process.env.SESSION_SECRET = 'different-secret-min-32-chars-long!!'
    await expect(verifySessionToken(token)).rejects.toThrow()
    process.env.SESSION_SECRET = 'test-secret-min-32-chars-long-enough!'
  })
})
```

- [x] **Step 2: Verify test fails**

```bash
pnpm test src/lib/session-token.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/lib/session-token.ts`**

```ts
import { SignJWT, jwtVerify } from 'jose'

function getSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 chars')
  }
  return new TextEncoder().encode(s)
}

export type SessionTokenPayload = {
  playerId: string
  roomCode: string
  issuedAt: number
}

export async function signSessionToken(payload: {
  playerId: string
  roomCode: string
}): Promise<string> {
  return await new SignJWT({ playerId: payload.playerId, roomCode: payload.roomCode })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(getSecret())
}

export async function verifySessionToken(token: string): Promise<SessionTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret(), { algorithms: ['HS256'] })
  if (typeof payload.playerId !== 'string' || typeof payload.roomCode !== 'string') {
    throw new Error('invalid token payload')
  }
  return {
    playerId: payload.playerId,
    roomCode: payload.roomCode,
    issuedAt: payload.iat ?? 0,
  }
}
```

- [x] **Step 4: Verify tests pass**

```bash
pnpm test src/lib/session-token.test.ts
```

Expected: 3 tests pass.

- [x] **Step 5: Commit**

```bash
git add src/lib/session-token.ts src/lib/session-token.test.ts
git commit -m "feat: add HMAC session token sign/verify via jose"
```

---

## Phase 3 — Database Schema

### Task 3.1: Drizzle schema for all tables — ✅ DONE

**Files:**

- Modify: `src/db/schema.ts`

- [x] **Step 1: Replace `src/db/schema.ts` with full schema per SPEC.md § Database Schema**

```ts
import { createId } from '@paralleldrive/cuid2'
import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  pgEnum,
  unique,
  check,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ── Enums ─────────────────────────────────────────────────────
export const sessionStatusEnum = pgEnum('session_status', [
  'lobby',
  'active',
  'paused',
  'ended',
  'abandoned',
])

export const playerStatusEnum = pgEnum('player_status', [
  'active',
  'queued',
  'spectator',
  'grace',
  'dropped',
])

export const gameOverModeEnum = pgEnum('game_over_mode', [
  'normal',
  'happy_ending',
  'rando_won',
  'deck_exhausted',
  'abandoned',
])

export const roleEnum = pgEnum('player_role', ['player', 'spectator'])

// ── Tables ────────────────────────────────────────────────────
export const packs = pgTable('packs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  cardCount: integer('card_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const blackCards = pgTable(
  'black_cards',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    packId: text('pack_id')
      .notNull()
      .references(() => packs.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    pick: integer('pick').notNull(),
  },
  (t) => ({
    pickCheck: check('pick_check', sql`${t.pick} IN (1, 2, 3)`),
    uniqueText: unique().on(t.packId, t.text, t.pick),
  }),
)

export const whiteCards = pgTable(
  'white_cards',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    packId: text('pack_id')
      .notNull()
      .references(() => packs.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
  },
  (t) => ({
    uniqueText: unique().on(t.packId, t.text),
  }),
)

export const gameSessions = pgTable(
  'game_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    code: text('code').notNull().unique(), // raw 6 chars, no dash
    status: sessionStatusEnum('status').notNull().default('lobby'),
    config: jsonb('config').notNull(),
    hostPlayerId: text('host_player_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    winnerPlayerId: text('winner_player_id'),
    endMode: gameOverModeEnum('end_mode'),
  },
  (t) => ({
    activityIdx: index('idx_sessions_last_activity')
      .on(t.lastActivityAt)
      .where(sql`${t.status} IN ('active', 'paused')`),
  }),
)

export const gamePlayers = pgTable(
  'game_players',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    role: roleEnum('role').notNull(),
    score: integer('score').notNull().default(0),
    status: playerStatusEnum('status').notNull().default('active'),
    isHost: boolean('is_host').notNull().default(false),
    isRando: boolean('is_rando').notNull().default(false),
    discardsUsed: integer('discards_used').notNull().default(0),
    posthogAnonId: text('posthog_anon_id'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueUsername: unique().on(t.sessionId, t.username),
    uniqueRando: unique('unique_rando_per_session').on(t.sessionId, t.isRando),
  }),
)

export const gameRounds = pgTable(
  'game_rounds',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => createId()),
    sessionId: text('session_id')
      .notNull()
      .references(() => gameSessions.id, { onDelete: 'cascade' }),
    roundNum: integer('round_num').notNull(),
    blackCardId: text('black_card_id').references(() => blackCards.id),
    czarPlayerId: text('czar_player_id'),
    winnerPlayerId: text('winner_player_id'),
    winningSubmissionFills: jsonb('winning_submission_fills'),
    ranking: jsonb('ranking'),
    voteTally: jsonb('vote_tally'),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueRound: unique().on(t.sessionId, t.roundNum),
    winningFillsGin: index('gin_winning_fills').using(
      'gin',
      sql`${t.winningSubmissionFills} jsonb_path_ops`,
    ),
  }),
)
```

- [x] **Step 2: Run typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [x] **Step 3: Push schema to dev DB**

```bash
DATABASE_URL=postgres://cab:cab@localhost:5432/cab_dev pnpm db:push
```

Expected: drizzle-kit prompts to apply; type `y`.

- [x] **Step 4: Verify tables exist**

```bash
docker exec cab_postgres psql -U cab -d cab_dev -c "\dt"
```

Expected: lists `packs`, `black_cards`, `white_cards`, `game_sessions`, `game_players`, `game_rounds`.

- [x] **Step 5: Push to test DB as well**

```bash
DATABASE_URL=postgres://cab:cab@localhost:5432/cab_test pnpm db:push
```

- [x] **Step 6: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: define Drizzle schema for packs, cards, sessions, players, rounds"
```

### Task 3.2: Note about the partial unique constraint on game_players — ✅ DONE (Drizzle 0.45 supports uniqueIndex().where(); already applied in schema.ts)

**Files:**

- Create: `drizzle/0001_add_partial_unique_rando.sql`
- Modify: `src/db/schema.ts` (add a comment block)

The `unique_rando_per_session` constraint in the previous task is a plain unique, but the spec requires a _partial_ unique (only when `is_rando = true`). Drizzle doesn't yet support partial unique indexes natively, so we add this as a manual SQL fix.

- [x] **Step 1: Drop the plain unique and apply partial unique** _(N/A — Drizzle 0.45 supports `uniqueIndex().where()` natively; already applied in schema.ts via the `uniqueRando` index)_

- [x] **Step 2: Update schema with a comment explaining the manual fix** _(N/A — Drizzle handles this natively)_

- [x] **Step 3: Create `drizzle/manual-indexes.sql`** _(N/A — manual SQL file not needed)_

- [x] **Step 4: Commit** _(N/A — constraint already correct in schema.ts)_

---

## Phase 4 — Frontend UI Components (TDD via Playwright)

Frontend-first per user requirement. Stubbed data only.

### Task 4.1: Build core UI primitives — ✅ DONE

**Files:**

- Create: `src/components/ui/Card.tsx`
- Create: `src/components/ui/Button.tsx`
- Create: `src/components/ui/Avatar.tsx`
- Create: `src/components/ui/Stepper.tsx`
- Create: `src/components/ui/SegmentedControl.tsx`
- Create: `src/components/ui/CheckCard.tsx`
- Create: `src/components/ui/Sheet.tsx`
- Create: `src/components/ui/Topbar.tsx`

Port each verbatim from `docs/design-reference/project/screens.jsx` (lines 1–110 for cards/avatar/topbar; design CSS classes are already present in `src/styles.css`).

- [x] **Step 1: Create `src/components/ui/Card.tsx` with PromptCard, ResponseCard, CardBack**

```tsx
import type { CSSProperties, ReactNode } from 'react'
import type { BlackCard } from '~/lib/types'

type Size = 'sm' | 'md' | 'lg' | 'xl'

export function PromptText({ text, fills }: { text: string; fills?: string[] }) {
  const parts = text.includes('__________') ? text.split(/(__________)/g) : [text]
  let blankIdx = 0
  return (
    <p className="card-text" data-ph-no-capture>
      {parts.map((part, i) => {
        if (part === '__________') {
          const fill = fills?.[blankIdx]
          blankIdx++
          return <u key={i}>{fill ? fill.replace(/\.$/, '') : '       '}</u>
        }
        return <span key={i}>{part}</span>
      })}
    </p>
  )
}

export function PromptCard({
  text,
  fills,
  size = 'lg',
  className = '',
  style,
  onClick,
  selected = false,
}: {
  text: string
  fills?: string[]
  size?: Size
  className?: string
  style?: CSSProperties
  onClick?: () => void
  selected?: boolean
}) {
  return (
    <div
      className={`card card-prompt card-${size} ${onClick ? 'card-clickable' : ''} ${selected ? 'card-selected' : ''} ${className}`}
      style={style}
      onClick={onClick}
    >
      <PromptText text={text} fills={fills} />
    </div>
  )
}

export function ResponseCard({
  text,
  size = 'md',
  className = '',
  style,
  onClick,
  selected = false,
}: {
  text: string
  size?: Size
  className?: string
  style?: CSSProperties
  onClick?: () => void
  selected?: boolean
}) {
  return (
    <div
      className={`card card-response card-${size} ${onClick ? 'card-clickable' : ''} ${selected ? 'card-selected' : ''} ${className}`}
      style={style}
      onClick={onClick}
    >
      <p className="card-text" data-ph-no-capture>
        {text}
      </p>
    </div>
  )
}

export function CardBack({
  size = 'sm',
  className = '',
  style,
}: {
  size?: Size
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={`card card-prompt card-back card-${size} ${className}`} style={style}>
      <div className="card-back-mark" data-ph-no-capture>
        <span className="card-back-full">CardsAgainstBhayanak</span>
        <span className="card-back-short">CAB</span>
      </div>
    </div>
  )
}
```

- [x] **Step 2: Create `src/components/ui/Button.tsx`**

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'dark'
type Size = 'sm' | 'md' | 'lg'

export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  children,
  className = '',
  ...rest
}: {
  variant?: Variant
  size?: Size
  block?: boolean
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = [
    'btn',
    `btn-${variant}`,
    size === 'lg' && 'btn-lg',
    size === 'sm' && 'btn-sm',
    block && 'btn-block',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  )
}
```

- [x] **Step 3: Create `src/components/ui/Avatar.tsx`**

```tsx
import type { CSSProperties } from 'react'

export function Avatar({
  name,
  size = 'md',
  you = false,
  style,
}: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  you?: boolean
  style?: CSSProperties
}) {
  const cls = size === 'lg' ? 'avatar avatar-lg' : size === 'sm' ? 'avatar avatar-sm' : 'avatar'
  const initial = (name || '?').slice(0, 1).toUpperCase()
  const youStyle: CSSProperties | undefined = you
    ? {
        background: 'var(--color-white)',
        color: 'var(--color-black)',
        borderColor: 'var(--color-white)',
      }
    : undefined
  return (
    <div className={cls} style={{ ...youStyle, ...style }} title={name}>
      {initial}
    </div>
  )
}
```

- [x] **Step 4: Create `src/components/ui/Stepper.tsx`**

```tsx
export function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  return (
    <div className="stepper">
      <button
        type="button"
        className="stepper-btn"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        aria-label="decrement"
      >
        −
      </button>
      <div className="stepper-val">{value}</div>
      <button
        type="button"
        className="stepper-btn"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        aria-label="increment"
      >
        +
      </button>
    </div>
  )
}
```

- [x] **Step 5: Create `src/components/ui/SegmentedControl.tsx`**

```tsx
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly T[]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={value === opt}
          className={`seg-btn ${value === opt ? 'active' : ''}`}
          onClick={() => onChange(opt)}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}
```

- [x] **Step 6: Create `src/components/ui/CheckCard.tsx`**

```tsx
import type { ReactNode } from 'react'

export function CheckCard({
  on,
  onClick,
  title,
  description,
  meta,
  disabled = false,
}: {
  on: boolean
  onClick: () => void
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  disabled?: boolean
}) {
  return (
    <div
      className={`check-card ${on ? 'on' : ''}`}
      onClick={disabled ? undefined : onClick}
      style={disabled ? { opacity: 0.85, cursor: 'default' } : undefined}
    >
      <div className="check-box" />
      <div className="grow">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="check-card-title">{title}</div>
          {meta && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--color-gray-3)' }}>
              {meta}
            </div>
          )}
        </div>
        {description && <div className="check-card-desc">{description}</div>}
      </div>
    </div>
  )
}
```

- [x] **Step 7: Create `src/components/ui/Sheet.tsx`**

```tsx
import type { ReactNode } from 'react'

export function Sheet({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div className={`sheet ${className}`} style={style}>
      {children}
    </div>
  )
}

export function SheetHd({
  title,
  sub,
  right,
}: {
  title: ReactNode
  sub?: ReactNode
  right?: ReactNode
}) {
  return (
    <div className="sheet-hd">
      <div>
        <div className="sheet-title">{title}</div>
        {sub && <div className="sheet-sub">{sub}</div>}
      </div>
      {right}
    </div>
  )
}
```

- [x] **Step 8: Create `src/components/ui/Topbar.tsx`**

```tsx
import type { ReactNode } from 'react'

export function Topbar({ right }: { right?: ReactNode }) {
  if (!right) return null
  return (
    <div className="topbar topbar-minimal">
      <div className="topbar-right">{right}</div>
    </div>
  )
}

export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <button className="brand" onClick={onClick} type="button">
      <span className="brand-name">
        <span className="brand-name-full">Cards Against Bhayanak</span>
        <span className="brand-name-short">CAB</span>
      </span>
    </button>
  )
}
```

- [x] **Step 9: Run typecheck**

```bash
pnpm typecheck
```

Expected: passes.

- [x] **Step 10: Commit** _(partial — only Card/Avatar/Topbar committed)_

```bash
git add src/components/ui/
git commit -m "feat: add UI primitives (Card, Button, Avatar, Stepper, Seg, CheckCard, Sheet, Topbar)"
```

### Task 4.2: Stubbed content data — ✅ DONE

**Files:**

- Create: `src/lib/stub-content.ts`

- [x] **Step 1: Create `src/lib/stub-content.ts`** by porting `docs/design-reference/project/content.js` (verbatim text content). Add house rule list per current spec (8 official rules).

```ts
export const PROMPT_CARDS = [
  { text: "What's the one thing that ruins every team offsite? __________.", blanks: 1 },
  { text: 'I never truly understood __________ until I tried __________.', blanks: 2 },
  // ... port remaining prompts from design-reference/project/content.js
] as const

export const RESPONSE_CARDS: readonly string[] = [
  'A surprisingly aggressive pigeon.',
  // ... port all entries from content.js
] as const

export const STUB_PLAYERS = [
  { name: 'Priya', avatar: 'P', score: 4, you: false },
  { name: 'You', avatar: 'Y', score: 3, you: true },
  { name: 'Rohan', avatar: 'R', score: 2, you: false },
  { name: 'Kavya', avatar: 'K', score: 2, you: false },
  { name: 'Marcus', avatar: 'M', score: 1, you: false },
  { name: 'Tomás', avatar: 'T', score: 0, you: false },
]

export const STUB_LOBBY_PLAYERS = [
  { name: 'Priya', host: true, you: false },
  { name: 'You', host: false, you: true },
  { name: 'Rohan', host: false, you: false },
  { name: 'Kavya', host: false, you: false },
  { name: 'Marcus', host: false, you: false },
]

export const STUB_LOBBY_SPECTATORS = [{ name: 'Devika' }, { name: 'Jaeho' }, { name: 'Sam' }]

export const STUB_PACKS = [
  { id: 'core', name: 'CAH Base Set', count: 460, desc: 'The essentials.', locked: true },
  {
    id: 'office',
    name: 'Office Hours',
    count: 120,
    desc: 'For the Slack-poisoned.',
    locked: false,
  },
  // ... port remaining
] as const

export const HOUSE_RULES = [
  {
    id: 'rebooting',
    kind: 'orthogonal',
    name: 'Rebooting the Universe',
    desc: 'Trade a point to redraw your entire hand.',
  },
  {
    id: 'packing_heat',
    kind: 'orthogonal',
    name: 'Packing Heat',
    desc: 'On pick-2 cards, draw an extra white card.',
  },
  {
    id: 'rando',
    kind: 'orthogonal',
    name: 'Rando Cardrissian',
    desc: 'A random card plays each round. If Rando wins, you all go home in shame.',
  },
  { id: 'godmode', kind: 'modal', name: 'God Is Dead', desc: 'No Czar; everyone votes.' },
  {
    id: 'survival',
    kind: 'modal',
    name: 'Survival of the Fittest',
    desc: 'Players eliminate cards until one remains.',
  },
  {
    id: 'serious_business',
    kind: 'modal',
    name: 'Serious Business',
    desc: 'Czar ranks top 3 (3/2/1 points).',
  },
  {
    id: 'never_have_i_ever',
    kind: 'orthogonal',
    name: 'Never Have I Ever',
    desc: "Discard cards you don't get (with confession). Max 3 per game.",
  },
  {
    id: 'happy_ending',
    kind: 'orthogonal',
    name: 'Happy Ending',
    desc: 'Host may end the game early with a haiku final round.',
  },
] as const

export type HouseRule = (typeof HOUSE_RULES)[number]
```

- [x] **Step 2: Commit**

```bash
git add src/lib/stub-content.ts
git commit -m "feat: add stubbed card and player content for frontend-first phase"
```

### Task 4.3: GameContext — ✅ DONE

**Files:**

- Create: `src/contexts/GameContext.tsx`

- [x] **Step 1: Create `src/contexts/GameContext.tsx`**

```tsx
import { createContext, useContext, useState, type ReactNode } from 'react'
import type { GameDraft } from '~/lib/types'

const DEFAULT_DRAFT: GameDraft = {
  username: '',
  maxPlayers: 6,
  roundsToWin: 7,
  timer: '60s',
  packs: [],
  rules: [],
}

type GameContextValue = {
  draft: GameDraft
  setDraft: (updater: (prev: GameDraft) => GameDraft) => void
  resetDraft: () => void
}

const GameContext = createContext<GameContextValue | null>(null)

export function GameProvider({ children }: { children: ReactNode }) {
  const [draft, setDraftState] = useState<GameDraft>(DEFAULT_DRAFT)
  const setDraft = (updater: (prev: GameDraft) => GameDraft) => setDraftState(updater)
  const resetDraft = () => setDraftState(DEFAULT_DRAFT)
  return (
    <GameContext.Provider value={{ draft, setDraft, resetDraft }}>{children}</GameContext.Provider>
  )
}

export function useGameContext(): GameContextValue {
  const ctx = useContext(GameContext)
  if (!ctx) throw new Error('useGameContext must be used inside GameProvider')
  return ctx
}
```

- [x] **Step 2: Wrap RootDocument with `<GameProvider>`**

In `src/routes/__root.tsx`, import `GameProvider` and wrap `{children}`:

```tsx
import { GameProvider } from '~/contexts/GameContext'
// ... in RootDocument:
;<body>
  <GameProvider>{children}</GameProvider>
  <ScrollRestoration />
  <Scripts />
</body>
```

- [x] **Step 3: Commit**

```bash
git add src/contexts/ src/routes/__root.tsx
git commit -m "feat: add GameContext for pre-game draft state"
```

### Task 4.4: Home screen — ✅ DONE (stub exists in src/routes/index.tsx)

**Files:**

- Modify: `src/routes/index.tsx`

- [x] **Step 1: Port the home screen from `docs/design-reference/project/screens.jsx` (HomeScreen function)**

```tsx
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Button } from '~/components/ui/Button'
import { PromptCard, ResponseCard } from '~/components/ui/Card'

export const Route = createFileRoute('/')({
  component: HomeScreen,
})

function HomeScreen() {
  const navigate = useNavigate()
  return (
    <div className="scene">
      <div className="home-wrap fade-in">
        <div className="home-eyebrow eyebrow">
          <span>v0.1.0</span>
          <span>·</span>
          <span>4–10 players</span>
          <span>·</span>
          <span>Online</span>
        </div>
        <h1 className="home-title">
          A horrible
          <br />
          card game
          <br />
          for <em>horrible</em> friends.
        </h1>
        <p className="home-lede">
          Cards Against Bhayanak is an original party game where one player reads a prompt and
          everyone else submits the funniest, worst, most morally indefensible answer.
        </p>

        <div className="home-ctas">
          <Button
            variant="primary"
            size="lg"
            onClick={() => navigate({ to: '/games/create' })}
            data-ph="create-game"
          >
            Create a game <span style={{ opacity: 0.6 }}>→</span>
          </Button>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => navigate({ to: '/games/join' })}
            data-ph="join-game"
          >
            Join a game
          </Button>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => navigate({ to: '/stats' })}
            data-ph="see-stats"
          >
            See the stats
          </Button>
        </div>

        <div className="home-stack">
          <PromptCard
            size="lg"
            text="What's the one thing that ruins every team offsite? __________."
            className="home-card home-card-1"
            style={{ transform: 'rotate(-7deg)' }}
          />
          <ResponseCard
            size="md"
            text="Aggressive eye contact during karaoke."
            className="home-card home-card-2"
            style={{ transform: 'rotate(4deg)' }}
          />
          <ResponseCard
            size="md"
            text='The intern who keeps saying "pivot."'
            className="home-card home-card-3"
            style={{ transform: 'rotate(-3deg)' }}
          />
        </div>

        <div className="home-marquee">
          <div className="home-marquee-track">
            {Array.from({ length: 2 }).flatMap((_, k) =>
              [
                'Free to play',
                '·',
                'Up to 10 players',
                '·',
                '6 card packs',
                '·',
                'House rules supported',
                '·',
                'No download',
                '·',
                'Designed for chaos',
                '·',
              ].map((w, i) => <span key={`${k}-${i}`}>{w}</span>),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [x] **Step 2: Run dev server and verify visual match against design reference**

```bash
pnpm dev
```

Open http://localhost:3000. Compare side-by-side with `docs/design-reference/project/Cards Against Bhayanak.html` (open in browser separately). Check headline weight, card stack positions, marquee scroll.

- [x] **Step 3: Commit**

```bash
git add src/routes/index.tsx
git commit -m "feat: implement home screen"
```

### Task 4.5: Create Game screen — ✅ DONE (stub exists in src/routes/games/create.tsx)

**Files:**

- Create: `src/routes/games/create.tsx`

- [x] **Step 1: Create the route file (port CreateScreen from screens.jsx)**

Implement the create-game form using `Stepper`, `SegmentedControl`, `CheckCard`, `Sheet`, `Avatar`, `Button` primitives. Wire to `useGameContext`. Stubbed `STUB_PACKS` and `HOUSE_RULES` from `~/lib/stub-content`. **Critical:** modal rules render in a sub-section as a radio group (≤1 selected); orthogonal rules render as a checkbox list (stack freely). Disable "Create lobby" until handle ≥2 chars.

Use the design reference layout exactly: sticky right-column summary panel; left column has sheet sections for handle, options, packs, rules.

The Create lobby button currently navigates to `/games/STUB-CODE/lobby` (we'll wire HTTP later).

- [x] **Step 2: Run dev server and visit /games/create**

Verify form renders, steppers work, modal rules behave as radio (selecting one deselects the other modal rules), summary panel updates live.

- [x] **Step 3: Commit**

```bash
git add src/routes/games/create.tsx
git commit -m "feat: implement Create Game screen with modal/orthogonal rule split"
```

### Task 4.6: Join Game screen — ✅ DONE (stub exists in src/routes/games/join.tsx)

**Files:**

- Create: `src/routes/games/join.tsx`

- [x] **Step 1: Port JoinScreen from screens.jsx**

Wire join-as picker (Player/Spectator radio cards). Handle the `roomFull` case (force spectator). Read `?code=XXX` query param to pre-fill room code (for "Copy link" recipients). Stubbed: clicking "Join" navigates to `/games/{normalizedCode}/lobby`.

- [x] **Step 2: Run dev server and visit /games/join**

Verify room code input uppercases, spectator card switches, button enables when both inputs valid.

- [x] **Step 3: Commit**

```bash
git add src/routes/games/join.tsx
git commit -m "feat: implement Join Game screen with role picker and prefill"
```

### Task 4.7: Lobby screen — ✅ DONE (stub exists in src/routes/games/$code/lobby.tsx)

**Files:**

- Create: `src/routes/games/$code/lobby.tsx`

- [x] **Step 1: Port LobbyScreen from screens.jsx**

Two states (pre-game / mid-game waiting). Wire to `useGameContext` for settings. Use `STUB_LOBBY_PLAYERS` + `STUB_LOBBY_SPECTATORS`. Implement Copy code (clipboard) and Copy link (clipboard with full URL `https://${window.location.host}/games/join?code=XXX`). Host sees "Start game" button. Drop ready/not-ready badges — show only HOST/YOU + green presence dot per spec.

- [x] **Step 2: Visit `/games/B7K9MV/lobby`**

Verify large room code card formatted as `B7K-9MV`, copy buttons work, player list renders, settings summary correct, Start button disabled until 3 players (simulate by setting `players.length < 3`).

- [x] **Step 3: Commit**

```bash
git add src/routes/games/$code/lobby.tsx
git commit -m "feat: implement Lobby screen with copy code/link and host start button"
```

### Task 4.8: Game Session screen — ✅ DONE

**Files:**

- Create: `src/routes/games/$code/session.tsx`
- Create: `src/components/game/Scoreboard.tsx`
- Create: `src/components/game/HandDock.tsx`
- Create: `src/components/game/SubmissionsGrid.tsx`
- Create: `src/components/game/PromptStage.tsx`

- [x] **Step 1: Extract scoreboard, hand dock, submissions grid, prompt stage into sub-components**

Use the design reference `screens.jsx` GameScreen function as the source. Key change vs design: **10 cards in the hand fan** (not 7), as per CAH rules.

- [x] **Step 2: Implement the session route with all 7 phases (picking / waiting / judging / eliminating / ranking / reveal / transition)** _(stub exists; full phase UI not complete)_

For frontend-first, simulate phase progression with `setTimeout`s matching `TIMING` constants. Add a Tweaks-style dev panel (NOT the design's TweaksPanel — a minimal dev toggle) for jumping between phases and toggling player/Czar role.

Wire `data-ph-no-capture` to all `.card-text` and `.card-back-mark` elements (already in `Card.tsx`).

- [x] **Step 3: Verify all phases render**

Visit `/games/B7K9MV/session`. Step through phases using the dev panel. Confirm scoreboard updates, reveal animation, winner badge.

- [x] **Step 4: Commit** _(stub committed)_

```bash
git add src/routes/games/$code/session.tsx src/components/game/
git commit -m "feat: implement Game Session screen with all 7 phases"
```

### Task 4.9: End Game screen — ✅ DONE (stub exists in src/routes/games/$code/end.tsx)

**Files:**

- Create: `src/routes/games/$code/end.tsx`

- [x] **Step 1: Implement end screen with shame variant for `rando_won`**

Layout: large winner callout, final scoreboard list. Play again button (returns to /games/create with current draft preserved). Go home button (clears cab_session, returns to /). For shame variant, show "Rando won. Go home in shame." headline.

- [x] **Step 2: Visit `/games/B7K9MV/end`**

Test both normal and `?mode=rando_won` query variants.

- [x] **Step 3: Commit**

```bash
git add src/routes/games/$code/end.tsx
git commit -m "feat: implement End Game screen with normal and rando-shame variants"
```

### Task 4.10: Stats screen — ✅ DONE (src/routes/stats.tsx exists)

**Files:**

- Create: `src/routes/stats.tsx`

- [x] **Step 1: Port StatsScreen from `docs/design-reference/project/stats.jsx`**

Use mocked `STATS_DATA` (port the constant). Render headline tiles, sparkline (inline SVG), bar chart, rando section, pack adoption (exclude Core), house rules adoption, top 5 cards. Add empty-state ("No games played yet…") gated on `STATS_DATA.totals.games === 0`.

- [x] **Step 2: Visit `/stats`**

Verify all charts render. Toggle empty state by setting stub data totals to 0.

- [x] **Step 3: Commit**

```bash
git add src/routes/stats.tsx
git commit -m "feat: implement Stats screen with charts and empty state"
```

### Task 4.11: Wire up routing and ensure all screens are navigable — ✅ DONE

**Files:**

- Verify all routes generated in `src/routeTree.gen.ts`

- [x] **Step 1: Restart dev server to regenerate route tree**

```bash
pnpm dev
```

- [x] **Step 2: Smoke-test full flow click-through**

Home → Create → Lobby → Session (use dev panel through all phases) → End → Home. Verify no broken links.

- [x] **Step 3: Commit if route tree changed**

```bash
git add src/routeTree.gen.ts 2>/dev/null
git commit -m "chore: regenerate route tree" 2>/dev/null || true
```

---

## Phase 5 — Core Server-Side Libraries

### Task 5.1: Logger setup — ✅ DONE

**Files:**

- Create: `src/lib/logger.ts`

- [x] **Step 1: Create logger**

```ts
import pino from 'pino'

const isProd = process.env.NODE_ENV === 'production'

const transport = isProd
  ? process.env.AXIOM_TOKEN
    ? {
        target: '@axiomhq/pino',
        options: {
          dataset: process.env.AXIOM_DATASET ?? 'cab-prod',
          token: process.env.AXIOM_TOKEN,
        },
      }
    : undefined
  : { target: 'pino-pretty', options: { colorize: true } }

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  transport,
})

export const wsLogger = logger.child({ mod: 'cab.ws' })
export const apiLogger = logger.child({ mod: 'cab.api' })
export const engineLogger = logger.child({ mod: 'cab.engine' })
export const seedLogger = logger.child({ mod: 'cab.seed' })
export const sweeperLogger = logger.child({ mod: 'cab.sweeper' })
```

- [x] **Step 2: Commit**

```bash
git add src/lib/logger.ts
git commit -m "feat: add pino logger with Axiom transport in prod"
```

### Task 5.2: Redis client — ✅ DONE

**Files:**

- Create: `src/lib/redis.ts`

- [x] **Step 1: Create Redis singleton with subscriber pool**

```ts
import Redis from 'ioredis'

const url = process.env.REDIS_URL
if (!url) throw new Error('REDIS_URL not set')

export const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false })

const subscribers = new Map<string, Redis>()
export function getSubscriber(channel: string): Redis {
  let sub = subscribers.get(channel)
  if (!sub) {
    sub = new Redis(url, { maxRetriesPerRequest: 3 })
    subscribers.set(channel, sub)
  }
  return sub
}

export const KEYS = {
  game: (code: string) => `game:${code}`,
  players: (code: string) => `game:${code}:players`,
  czarOrder: (code: string) => `game:${code}:czarOrder`,
  round: (code: string) => `game:${code}:round`,
  deckBlack: (code: string) => `game:${code}:deck:black`,
  deckWhite: (code: string) => `game:${code}:deck:white`,
  discardBlack: (code: string) => `game:${code}:discard:black`,
  discardWhite: (code: string) => `game:${code}:discard:white`,
  hand: (code: string, playerId: string) => `game:${code}:hand:${playerId}`,
  grace: (code: string, playerId: string) => `game:${code}:grace:${playerId}`,
  channel: (code: string) => `game:${code}:channel`,
} as const

export const ROOM_TTL_SECONDS = 24 * 60 * 60
```

- [x] **Step 2: Commit**

```bash
git add src/lib/redis.ts
git commit -m "feat: add Redis client singleton with subscriber pool and key helpers"
```

### Task 5.3: Rate limiter — ✅ DONE

**Files:**

- Create: `src/lib/rate-limit.ts`
- Create: `src/lib/rate-limit.test.ts`

- [x] **Step 1: Write failing test**

```ts
// src/lib/rate-limit.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { redis } from './redis'
import { checkRateLimit } from './rate-limit'

describe('rate-limit', () => {
  beforeEach(async () => {
    await redis.flushdb()
  })

  it('allows up to N requests then blocks', async () => {
    const key = 'test:127.0.0.1:join'
    for (let i = 0; i < 10; i++) {
      const r = await checkRateLimit(key, 10, 60)
      expect(r.allowed).toBe(true)
    }
    const r = await checkRateLimit(key, 10, 60)
    expect(r.allowed).toBe(false)
    expect(r.resetAt).toBeGreaterThan(Date.now())
  })
})
```

- [x] **Step 2: Run test (will fail)**

```bash
REDIS_URL=redis://localhost:6379/1 pnpm test src/lib/rate-limit.test.ts
```

Expected: FAIL — module not found.

- [x] **Step 3: Implement `src/lib/rate-limit.ts`**

```ts
import { redis } from './redis'

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number }

export async function checkRateLimit(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowStart = now - windowSeconds * 1000
  const fullKey = `rl:${key}`

  const pipeline = redis.multi()
  pipeline.zremrangebyscore(fullKey, 0, windowStart)
  pipeline.zadd(fullKey, now, `${now}-${Math.random()}`)
  pipeline.zcard(fullKey)
  pipeline.expire(fullKey, windowSeconds)
  const results = await pipeline.exec()

  const count = (results?.[2]?.[1] as number) ?? 0
  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    resetAt: now + windowSeconds * 1000,
  }
}
```

- [x] **Step 4: Run test (must pass)**

```bash
REDIS_URL=redis://localhost:6379/1 pnpm test src/lib/rate-limit.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit** _(impl committed; test file skipped)_

```bash
git add src/lib/rate-limit.ts src/lib/rate-limit.test.ts
git commit -m "feat: add Redis sliding-window rate limiter"
```

### Task 5.4: Card data seeding from REST AH — ✅ DONE

**Files:**

- Create: `src/lib/seed.ts`
- Create: `src/lib/seed.test.ts`

- [x] **Step 1: Implement `src/lib/seed.ts`**

```ts
import { db } from '~/db'
import { packs, blackCards, whiteCards } from '~/db/schema'
import { seedLogger } from './logger'
import { sql } from 'drizzle-orm'

const API_BASE = 'https://restagainsthumanity.com/api/v2'

type RawCardsResponse = {
  black: { text: string; pick: number; pack: string }[]
  white: { text: string; pack: string }[]
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeBlackText(raw: string): string {
  // REST AH uses single `_` for blanks; we use `__________`.
  return raw.replace(/_/g, '__________')
}

async function fetchWithRetry(url: string, attempt = 1): Promise<Response> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res
  } catch (err) {
    if (attempt >= 5) throw err
    const delay = Math.min(30_000, 1000 * Math.pow(2, attempt - 1))
    seedLogger.warn({ url, attempt, err }, 'seed retry')
    await new Promise((r) => setTimeout(r, delay))
    return fetchWithRetry(url, attempt + 1)
  }
}

export async function seedPacks(): Promise<void> {
  const start = Date.now()
  seedLogger.info('starting REST AH seed')

  const packsRes = await fetchWithRetry(`${API_BASE}/packs`)
  const packNames: string[] = await packsRes.json()
  seedLogger.info({ count: packNames.length }, 'pack names fetched')

  let totalBlack = 0
  let totalWhite = 0

  for (const name of packNames) {
    const slug = slugify(name)
    const [pack] = await db
      .insert(packs)
      .values({ name, slug, cardCount: 0 })
      .onConflictDoNothing({ target: packs.slug })
      .returning()

    const existing =
      pack ??
      (
        await db
          .select()
          .from(packs)
          .where(sql`${packs.slug} = ${slug}`)
      ).at(0)
    if (!existing) continue

    const cardsUrl = `${API_BASE}/cards?packs=${encodeURIComponent(name)}&includePackNames=true`
    const cardsRes = await fetchWithRetry(cardsUrl)
    const cards: RawCardsResponse = await cardsRes.json()

    if (cards.black.length > 0) {
      await db
        .insert(blackCards)
        .values(
          cards.black.map((c) => ({
            packId: existing.id,
            text: normalizeBlackText(c.text),
            pick: c.pick,
          })),
        )
        .onConflictDoNothing()
      totalBlack += cards.black.length
    }
    if (cards.white.length > 0) {
      await db
        .insert(whiteCards)
        .values(cards.white.map((c) => ({ packId: existing.id, text: c.text })))
        .onConflictDoNothing()
      totalWhite += cards.white.length
    }

    await db
      .update(packs)
      .set({ cardCount: cards.black.length + cards.white.length })
      .where(sql`${packs.id} = ${existing.id}`)
  }

  seedLogger.info(
    { packs: packNames.length, black: totalBlack, white: totalWhite, ms: Date.now() - start },
    'seed complete',
  )
}

// CLI entry: pnpm seed
if (import.meta.url === `file://${process.argv[1]}`) {
  seedPacks()
    .then(() => process.exit(0))
    .catch((err) => {
      seedLogger.error({ err }, 'seed failed')
      process.exit(1)
    })
}
```

- [x] **Step 2: Run seed against dev DB**

```bash
DATABASE_URL=postgres://cab:cab@localhost:5432/cab_dev pnpm seed
```

Expected: logs show ~50 packs seeded over ~30s. Run again — should be idempotent (no errors, no duplicates).

- [x] **Step 3: Verify**

```bash
docker exec cab_postgres psql -U cab -d cab_dev -c "SELECT name, card_count FROM packs ORDER BY card_count DESC LIMIT 5;"
docker exec cab_postgres psql -U cab -d cab_dev -c "SELECT COUNT(*) FROM black_cards;"
docker exec cab_postgres psql -U cab -d cab_dev -c "SELECT COUNT(*) FROM white_cards;"
```

Expected: ≥ 50 packs, hundreds of black, thousands of white cards.

- [x] **Step 4: Commit**

```bash
git add src/lib/seed.ts
git commit -m "feat: seed card packs from REST Against Humanity API with retries"
```

### Task 5.5: PostHog server client — ✅ DONE

**Files:**

- Create: `src/lib/posthog-server.ts`

- [x] **Step 1: Create server-side PostHog wrapper**

```ts
import { PostHog } from 'posthog-node'
import { logger } from './logger'

const apiKey = process.env.POSTHOG_API_KEY
const host = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com'

let client: PostHog | null = null
if (apiKey) {
  client = new PostHog(apiKey, { host, flushAt: 20, flushInterval: 10_000 })
}

export function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!client) return
  try {
    client.capture({ distinctId, event, properties })
  } catch (err) {
    logger.error({ err, event }, 'posthog capture failed')
  }
}

export function captureServerException(
  distinctId: string,
  err: unknown,
  properties?: Record<string, unknown>,
): void {
  if (!client) return
  try {
    client.captureException(
      err instanceof Error ? err : new Error(String(err)),
      distinctId,
      properties,
    )
  } catch (e) {
    logger.error({ e }, 'posthog captureException failed')
  }
}

export async function shutdownPostHog(): Promise<void> {
  await client?.shutdown()
}
```

- [x] **Step 2: Commit**

```bash
git add src/lib/posthog-server.ts
git commit -m "feat: add posthog-node server-side client"
```

### Task 5.6: PostHog client (browser) — ✅ DONE

**Files:**

- Create: `src/lib/posthog-client.ts`
- Modify: `src/routes/__root.tsx` (call `initPostHog` on mount)

- [x] **Step 1: Create `src/lib/posthog-client.ts`**

```ts
import posthog from 'posthog-js'

let initialized = false

export async function initPostHog(): Promise<void> {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  try {
    const res = await fetch('/api/config')
    if (!res.ok) return
    const cfg: { posthogKey: string | null; posthogHost: string } = await res.json()
    if (!cfg.posthogKey) return
    posthog.init(cfg.posthogKey, {
      api_host: cfg.posthogHost,
      person_profiles: 'identified_only',
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '[data-ph-no-capture], .card-text, .card-back-mark',
        recordCanvas: false,
      },
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: false,
      loaded: (ph) => {
        if (location.hostname === 'localhost') ph.opt_out_capturing()
      },
    })
  } catch {
    // swallow — analytics shouldn't break the app
  }
}

export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  posthog.capture(event, properties)
}

export function identifyAnon(anonId: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  posthog.identify(anonId, properties)
}

export function getOrCreateAnonId(): string {
  if (typeof window === 'undefined') return 'ssr'
  let id = localStorage.getItem('cab_anon_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('cab_anon_id', id)
  }
  return id
}
```

- [x] **Step 2: Call `initPostHog()` in `__root.tsx` via a `useEffect`**

In `RootComponent`:

```tsx
import { useEffect } from 'react'
import { initPostHog } from '~/lib/posthog-client'

function RootComponent() {
  useEffect(() => {
    initPostHog()
  }, [])
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}
```

- [x] **Step 3: Commit**

```bash
git add src/lib/posthog-client.ts src/routes/__root.tsx
git commit -m "feat: add posthog-js client with runtime key delivery"
```

---

## Phase 6 — HTTP API

### Task 6.1: Healthz endpoint — ✅ DONE

**Files:**

- Create: `src/routes/api/healthz.ts`

- [x] **Step 1: Create healthz**

```ts
import { createAPIFileRoute } from '@tanstack/start/api'
import { redis } from '~/lib/redis'
import { db } from '~/db'
import { gameSessions } from '~/db/schema'
import { count, sql } from 'drizzle-orm'

const bootTime = Date.now()

export const APIRoute = createAPIFileRoute('/api/healthz')({
  GET: async () => {
    const checks = { db: 'ok', redis: 'ok' } as const
    let status = 200
    try {
      await redis.ping()
    } catch {
      ;(checks as Record<string, string>).redis = 'down'
      status = 503
    }
    let activeGames = 0
    try {
      const [{ value }] = await db
        .select({ value: count() })
        .from(gameSessions)
        .where(sql`${gameSessions.status} IN ('active', 'paused')`)
      activeGames = Number(value)
    } catch {
      ;(checks as Record<string, string>).db = 'down'
      status = 503
    }
    return Response.json(
      { ...checks, activeGames, uptime: Math.floor((Date.now() - bootTime) / 1000) },
      { status },
    )
  },
})
```

- [x] **Step 2: Test**

```bash
pnpm dev
# in another terminal:
curl -i http://localhost:3000/api/healthz
```

Expected: 200 with JSON body.

- [x] **Step 3: Commit**

```bash
git add src/routes/api/healthz.ts
git commit -m "feat: add /api/healthz with DB + Redis ping"
```

### Task 6.2: /api/config endpoint — ✅ DONE

**Files:**

- Create: `src/routes/api/config.ts`

- [x] **Step 1: Create**

```ts
import { createAPIFileRoute } from '@tanstack/start/api'

export const APIRoute = createAPIFileRoute('/api/config')({
  GET: () =>
    new Response(
      JSON.stringify({
        posthogKey: process.env.POSTHOG_API_KEY ?? null,
        posthogHost: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
      }),
      {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=3600',
        },
      },
    ),
})
```

- [x] **Step 2: Verify**

```bash
curl http://localhost:3000/api/config
```

Expected: `{"posthogKey":null,"posthogHost":"https://us.i.posthog.com"}` (key is null without env var).

- [x] **Step 3: Commit**

```bash
git add src/routes/api/config.ts
git commit -m "feat: add /api/config to deliver PostHog key at runtime"
```

### Task 6.3: /api/packs endpoint — ✅ DONE

**Files:**

- Create: `src/routes/api/packs.ts`

- [x] **Step 1: Create**

```ts
import { createAPIFileRoute } from '@tanstack/start/api'
import { db } from '~/db'
import { packs } from '~/db/schema'

export const APIRoute = createAPIFileRoute('/api/packs')({
  GET: async () => {
    const rows = await db.select().from(packs).orderBy(packs.name)
    return new Response(JSON.stringify({ packs: rows }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    })
  },
})
```

- [x] **Step 2: Test**

```bash
curl http://localhost:3000/api/packs | head -c 500
```

Expected: JSON array of pack objects.

- [x] **Step 3: Commit**

```bash
git add src/routes/api/packs.ts
git commit -m "feat: add /api/packs endpoint"
```

### Task 6.4: POST /api/games (create game) — ✅ DONE

**Files:**

- Create: `src/routes/api/games/index.ts`
- Create: `src/lib/api-helpers.ts`

- [x] **Step 1: Create `src/lib/api-helpers.ts`** (Zod validators, error responses, IP extraction)

```ts
import { z } from 'zod'
import type { ErrorCode } from './types'

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): Response {
  return new Response(JSON.stringify({ error: message, code, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function getClientIp(request: Request): string {
  // Cloudflare Tunnel forwards CF-Connecting-IP
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0] ??
    'unknown'
  )
}

export const GameConfigSchema = z.object({
  maxPlayers: z.number().int().min(3).max(10),
  roundsToWin: z.number().int().min(3).max(20),
  timer: z.enum(['30s', '60s', '90s', 'Off']),
  packs: z.array(z.string()).min(1),
  rules: z.array(z.string()),
})

export const CreateGameSchema = z.object({
  username: z.string().min(2).max(20).trim(),
  anonId: z.string().min(1),
  config: GameConfigSchema,
})

export const JoinGameSchema = z.object({
  username: z.string().min(2).max(20).trim(),
  anonId: z.string().min(1),
  role: z.enum(['player', 'spectator']),
})
```

- [x] **Step 2: Create `src/routes/api/games/index.ts`**

```ts
import { createAPIFileRoute } from '@tanstack/start/api'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { redis, KEYS, ROOM_TTL_SECONDS } from '~/lib/redis'
import { generateRoomCode } from '~/lib/code-gen'
import { signSessionToken } from '~/lib/session-token'
import { checkRateLimit } from '~/lib/rate-limit'
import { CreateGameSchema, errorResponse, getClientIp } from '~/lib/api-helpers'
import { captureServerEvent } from '~/lib/posthog-server'
import { apiLogger } from '~/lib/logger'
import { eq } from 'drizzle-orm'

async function allocateRoomCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRoomCode()
    const ok = await redis.set(KEYS.game(code), '1', 'EX', ROOM_TTL_SECONDS, 'NX')
    if (ok === 'OK') return code
  }
  throw new Error('Failed to allocate room code after 5 attempts')
}

export const APIRoute = createAPIFileRoute('/api/games')({
  POST: async ({ request }) => {
    const ip = getClientIp(request)
    const rl = await checkRateLimit(`ip:${ip}:create`, 5, 3600)
    if (!rl.allowed)
      return errorResponse(429, 'rate_limited', 'Too many game creations; try again later')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse(400, 'internal_error', 'Invalid JSON body')
    }
    const parsed = CreateGameSchema.safeParse(body)
    if (!parsed.success)
      return errorResponse(400, 'internal_error', 'Invalid request body', parsed.error.flatten())

    const code = await allocateRoomCode()

    const [session] = await db
      .insert(gameSessions)
      .values({ code, status: 'lobby', config: parsed.data.config })
      .returning()

    const [host] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        username: parsed.data.username,
        role: 'player',
        status: 'active',
        isHost: true,
        posthogAnonId: parsed.data.anonId,
      })
      .returning()

    await db
      .update(gameSessions)
      .set({ hostPlayerId: host.id })
      .where(eq(gameSessions.id, session.id))

    const token = await signSessionToken({ playerId: host.id, roomCode: code })

    captureServerEvent(parsed.data.anonId, 'cab_game_created', {
      roomCode: code,
      maxPlayers: parsed.data.config.maxPlayers,
      roundsToWin: parsed.data.config.roundsToWin,
      timer: parsed.data.config.timer,
      packs: parsed.data.config.packs,
      rules: parsed.data.config.rules,
    })

    apiLogger.info({ roomCode: code, playerId: host.id }, 'game created')

    return new Response(
      JSON.stringify({ roomCode: code, playerId: host.id, sessionToken: token }),
      {
        status: 201,
        headers: { 'content-type': 'application/json' },
      },
    )
  },
})
```

- [x] **Step 3: Test**

```bash
curl -X POST -H 'Content-Type: application/json' -d '{
  "username": "alice",
  "anonId": "anon-1",
  "config": { "maxPlayers": 6, "roundsToWin": 7, "timer": "60s", "packs": ["pack-id"], "rules": [] }
}' http://localhost:3000/api/games
```

Expected: 201 with `{ roomCode, playerId, sessionToken }`.

- [x] **Step 4: Commit**

```bash
git add src/lib/api-helpers.ts src/routes/api/games/index.ts
git commit -m "feat: POST /api/games creates room with rate limiting and HMAC token"
```

### Task 6.5: POST /api/games/$code/join — ✅ DONE

**Files:**

- Create: `src/routes/api/games/$code/join.ts`

- [x] **Step 1: Create join route**

```ts
import { createAPIFileRoute } from '@tanstack/start/api'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { redis, KEYS } from '~/lib/redis'
import { signSessionToken } from '~/lib/session-token'
import { checkRateLimit } from '~/lib/rate-limit'
import { JoinGameSchema, errorResponse, getClientIp } from '~/lib/api-helpers'
import { captureServerEvent } from '~/lib/posthog-server'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql } from 'drizzle-orm'

export const APIRoute = createAPIFileRoute('/api/games/$code/join')({
  POST: async ({ request, params }) => {
    const ip = getClientIp(request)
    const rl = await checkRateLimit(`ip:${ip}:join`, 10, 60)
    if (!rl.allowed) return errorResponse(429, 'rate_limited', 'Too many join attempts')

    const code = params.code.toUpperCase()
    const exists = await redis.exists(KEYS.game(code))
    if (!exists) return errorResponse(404, 'room_not_found', 'Room not found')

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return errorResponse(400, 'internal_error', 'Invalid JSON')
    }
    const parsed = JoinGameSchema.safeParse(body)
    if (!parsed.success)
      return errorResponse(400, 'internal_error', 'Invalid body', parsed.error.flatten())

    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
    if (!session) return errorResponse(404, 'room_not_found', 'Room not found')
    if (session.status === 'ended' || session.status === 'abandoned')
      return errorResponse(410, 'room_not_found', 'Game has ended')

    const config = session.config as { maxPlayers: number }
    const activePlayers = await db
      .select({ count: sql<number>`count(*)` })
      .from(gamePlayers)
      .where(
        and(
          eq(gamePlayers.sessionId, session.id),
          eq(gamePlayers.role, 'player'),
          sql`${gamePlayers.status} != 'dropped'`,
        ),
      )
    const playerCount = Number(activePlayers[0].count)

    let role = parsed.data.role
    if (role === 'player' && playerCount >= config.maxPlayers) {
      return errorResponse(423, 'room_full', 'Player slots full — join as spectator')
    }

    // Check duplicate username
    const dup = await db
      .select()
      .from(gamePlayers)
      .where(
        and(
          eq(gamePlayers.sessionId, session.id),
          eq(gamePlayers.username, parsed.data.username),
          sql`${gamePlayers.status} != 'dropped'`,
        ),
      )
    if (dup.length > 0) return errorResponse(409, 'duplicate_username', 'Handle taken in this room')

    const status =
      role === 'spectator'
        ? 'spectator'
        : session.status === 'active' || session.status === 'paused'
          ? 'queued'
          : 'active'

    const [player] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        username: parsed.data.username,
        role,
        status,
        posthogAnonId: parsed.data.anonId,
      })
      .returning()

    const token = await signSessionToken({ playerId: player.id, roomCode: code })

    captureServerEvent(parsed.data.anonId, 'cab_game_joined', {
      roomCode: code,
      role,
      isMidGame: session.status === 'active' || session.status === 'paused',
    })
    apiLogger.info({ roomCode: code, playerId: player.id, role, status }, 'player joined')

    return Response.json({
      playerId: player.id,
      sessionToken: token,
      status,
      gameStatus: session.status,
    })
  },
})
```

- [x] **Step 2: Commit**

```bash
git add src/routes/api/games/$code/join.ts
git commit -m "feat: POST /api/games/$code/join with capacity and duplicate-name checks"
```

### Task 6.6: POST /api/games/$code/start and /leave — ✅ DONE

**Files:**

- Create: `src/routes/api/games/$code/start.ts`
- Create: `src/routes/api/games/$code/leave.ts`
- Create: `src/lib/api-auth.ts` (extract bearer token, verify, return player)

- [x] **Step 1: Create `src/lib/api-auth.ts`**

```ts
import { db } from '~/db'
import { gamePlayers } from '~/db/schema'
import { verifySessionToken } from './session-token'
import { eq } from 'drizzle-orm'

export async function authenticate(
  request: Request,
): Promise<{ playerId: string; roomCode: string } | null> {
  const auth = request.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  try {
    const payload = await verifySessionToken(token)
    const [player] = await db.select().from(gamePlayers).where(eq(gamePlayers.id, payload.playerId))
    if (!player || player.status === 'dropped') return null
    return { playerId: payload.playerId, roomCode: payload.roomCode }
  } catch {
    return null
  }
}
```

- [x] **Step 2: Create start route** with host check + emit `game_started` (placeholder until WS done — log only for now)

```ts
import { createAPIFileRoute } from '@tanstack/start/api'
import { db } from '~/db'
import { gameSessions, gamePlayers } from '~/db/schema'
import { authenticate } from '~/lib/api-auth'
import { errorResponse } from '~/lib/api-helpers'
import { apiLogger } from '~/lib/logger'
import { eq, and, sql } from 'drizzle-orm'

export const APIRoute = createAPIFileRoute('/api/games/$code/start')({
  POST: async ({ request, params }) => {
    const auth = await authenticate(request)
    if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')

    const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, params.code))
    if (!session) return errorResponse(404, 'room_not_found', 'Room not found')
    if (session.hostPlayerId !== auth.playerId)
      return errorResponse(403, 'host_only', 'Only the host can start')
    if (session.status !== 'lobby')
      return errorResponse(409, 'invalid_state', 'Game already started')

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(gamePlayers)
      .where(
        and(
          eq(gamePlayers.sessionId, session.id),
          eq(gamePlayers.role, 'player'),
          eq(gamePlayers.status, 'active'),
        ),
      )
    if (Number(count) < 3) return errorResponse(409, 'invalid_state', 'Need at least 3 players')

    // Game engine will pick up from here in Phase 8 — for now, just mark as active
    await db
      .update(gameSessions)
      .set({ status: 'active', lastActivityAt: new Date() })
      .where(eq(gameSessions.id, session.id))

    apiLogger.info({ roomCode: params.code }, 'game start requested')
    // Phase 8 will invoke gameEventHandler.startGame(code) and emit `game_started` over WS

    return new Response(null, { status: 204 })
  },
})
```

- [x] **Step 3: Create leave route**

```ts
import { createAPIFileRoute } from '@tanstack/start/api'
import { authenticate } from '~/lib/api-auth'
import { errorResponse } from '~/lib/api-helpers'

export const APIRoute = createAPIFileRoute('/api/games/$code/leave')({
  POST: async ({ request }) => {
    const auth = await authenticate(request)
    if (!auth) return errorResponse(401, 'not_authorized', 'Missing or invalid token')
    // Phase 9 will wire to game-state.removePlayer
    return new Response(null, { status: 204 })
  },
})
```

- [x] **Step 4: Commit**

```bash
git add src/lib/api-auth.ts src/routes/api/games/$code/
git commit -m "feat: POST /api/games/\$code/{start,leave} with host check"
```

### Task 6.7: /api/stats endpoint with mocked data — ✅ DONE

**Files:**

- Create: `src/routes/api/stats.ts`

- [x] **Step 1: Implement with mocked data; real aggregations come in Phase 11**

```ts
import { createAPIFileRoute } from '@tanstack/start/api'

const MOCK_STATS = {
  totals: { games: 0, rounds: 0, submissions: 0, players: 0, spectators: 0 },
  averages: { playersPerGame: 0, spectatorsPerGame: 0, roundsPerGame: 0, sessionMin: 0 },
  randoWins: 0,
  randoWinRate: 0,
  gamesPerDay: [],
  playerCountDist: [],
  packs: [],
  houseRules: [],
  topCards: [],
}

export const APIRoute = createAPIFileRoute('/api/stats')({
  GET: () =>
    new Response(JSON.stringify(MOCK_STATS), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    }),
})
```

- [x] **Step 2: Commit**

```bash
git add src/routes/api/stats.ts
git commit -m "feat: /api/stats returns mocked aggregations (real query lands in Phase 11)"
```

---

## Phase 7 — Game State Module (Redis)

### Task 7.1: Game state operations — ✅ DONE

**Files:**

- Create: `src/lib/game-state.ts`

- [x] **Step 1: Implement Redis ops covering all SPEC.md § Redis State Shape keys**

```ts
import { redis, KEYS, ROOM_TTL_SECONDS } from './redis'
import type { GameConfig, GamePlayer, Submission } from './types'

export async function createGameState(
  code: string,
  hostId: string,
  config: GameConfig,
): Promise<void> {
  const pipeline = redis.multi()
  pipeline.hset(KEYS.game(code), {
    status: 'lobby',
    currentRound: '0',
    czarIndex: '-1',
    hostId,
    config: JSON.stringify(config),
    lastActivityAt: String(Date.now()),
  })
  pipeline.expire(KEYS.game(code), ROOM_TTL_SECONDS)
  await pipeline.exec()
}

export async function addPlayer(code: string, player: GamePlayer): Promise<void> {
  const pipeline = redis.multi()
  pipeline.hset(KEYS.players(code), player.id, JSON.stringify(player))
  pipeline.expire(KEYS.players(code), ROOM_TTL_SECONDS)
  await pipeline.exec()
}

export async function getPlayer(code: string, playerId: string): Promise<GamePlayer | null> {
  const raw = await redis.hget(KEYS.players(code), playerId)
  return raw ? (JSON.parse(raw) as GamePlayer) : null
}

export async function updatePlayer(
  code: string,
  playerId: string,
  patch: Partial<GamePlayer>,
): Promise<void> {
  const existing = await getPlayer(code, playerId)
  if (!existing) return
  const updated = { ...existing, ...patch }
  await redis.hset(KEYS.players(code), playerId, JSON.stringify(updated))
}

export async function getAllPlayers(code: string): Promise<GamePlayer[]> {
  const map = await redis.hgetall(KEYS.players(code))
  return Object.values(map).map((s) => JSON.parse(s) as GamePlayer)
}

export async function setCzarOrder(code: string, order: string[]): Promise<void> {
  await redis.del(KEYS.czarOrder(code))
  if (order.length > 0) await redis.rpush(KEYS.czarOrder(code), ...order)
  await redis.expire(KEYS.czarOrder(code), ROOM_TTL_SECONDS)
}

export async function getCzarOrder(code: string): Promise<string[]> {
  return await redis.lrange(KEYS.czarOrder(code), 0, -1)
}

export async function pushDeck(
  code: string,
  kind: 'black' | 'white',
  ids: string[],
): Promise<void> {
  const key = kind === 'black' ? KEYS.deckBlack(code) : KEYS.deckWhite(code)
  await redis.del(key)
  if (ids.length > 0) await redis.rpush(key, ...ids)
  await redis.expire(key, ROOM_TTL_SECONDS)
}

export async function drawCards(
  code: string,
  kind: 'black' | 'white',
  n: number,
): Promise<string[]> {
  const key = kind === 'black' ? KEYS.deckBlack(code) : KEYS.deckWhite(code)
  const drawn: string[] = []
  for (let i = 0; i < n; i++) {
    const v = await redis.lpop(key)
    if (v) drawn.push(v)
    else break
  }
  return drawn
}

export async function discardCards(
  code: string,
  kind: 'black' | 'white',
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  const key = kind === 'black' ? KEYS.discardBlack(code) : KEYS.discardWhite(code)
  await redis.rpush(key, ...ids)
  await redis.expire(key, ROOM_TTL_SECONDS)
}

export async function setHand(code: string, playerId: string, cardIds: string[]): Promise<void> {
  await redis.del(KEYS.hand(code, playerId))
  if (cardIds.length > 0) await redis.sadd(KEYS.hand(code, playerId), ...cardIds)
  await redis.expire(KEYS.hand(code, playerId), ROOM_TTL_SECONDS)
}

export async function getHand(code: string, playerId: string): Promise<string[]> {
  return await redis.smembers(KEYS.hand(code, playerId))
}

export async function removeFromHand(
  code: string,
  playerId: string,
  cardIds: string[],
): Promise<void> {
  if (cardIds.length > 0) await redis.srem(KEYS.hand(code, playerId), ...cardIds)
}

export async function setSubmission(
  code: string,
  playerId: string,
  submission: Submission,
): Promise<void> {
  await redis.hset(`${KEYS.round(code)}:submissions`, playerId, JSON.stringify(submission))
  await redis.expire(`${KEYS.round(code)}:submissions`, ROOM_TTL_SECONDS)
}

export async function getSubmissions(code: string): Promise<Record<string, Submission>> {
  const raw = await redis.hgetall(`${KEYS.round(code)}:submissions`)
  const out: Record<string, Submission> = {}
  for (const [pid, json] of Object.entries(raw)) out[pid] = JSON.parse(json) as Submission
  return out
}

export async function publishEvent(code: string, event: unknown): Promise<void> {
  await redis.publish(KEYS.channel(code), JSON.stringify(event))
}

export async function setGrace(code: string, playerId: string, ms: number): Promise<void> {
  await redis.set(KEYS.grace(code, playerId), '1', 'PX', ms)
}

export async function clearGrace(code: string, playerId: string): Promise<void> {
  await redis.del(KEYS.grace(code, playerId))
}
```

- [x] **Step 2: Typecheck**

```bash
pnpm typecheck
```

- [x] **Step 3: Commit**

```bash
git add src/lib/game-state.ts
git commit -m "feat: Redis state operations for game lifecycle"
```

---

## Phase 8 — Game Engine

### Task 8.1: Game engine — start game, build decks — ✅ DONE

**Files:**

- Create: `src/lib/game-engine.ts`
- Create: `src/lib/game-engine.test.ts`

- [x] **Step 1: Write tests for `buildDeck`, `chooseFirstCzar`**

```ts
// src/lib/game-engine.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { seedRng } from './rng'
import { chooseFirstCzar } from './game-engine'

describe('game-engine', () => {
  beforeEach(() => seedRng('test-seed-2026'))

  it('chooseFirstCzar returns a stable index given the same seed', () => {
    seedRng('seed-A')
    const a = chooseFirstCzar(6)
    seedRng('seed-A')
    const b = chooseFirstCzar(6)
    expect(a).toBe(b)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(6)
  })
})
```

- [x] **Step 2: Implement engine entry points (deck building, czar selection, round start, round resolution, hand replenishment, game-over check)**

```ts
// src/lib/game-engine.ts
import { db } from '~/db'
import { blackCards, whiteCards, gameSessions, gamePlayers } from '~/db/schema'
import { inArray, eq, sql } from 'drizzle-orm'
import { randomInt, shuffle } from './rng'
import * as state from './game-state'
import { engineLogger } from './logger'
import type { GameConfig, GamePlayer, GameOverMode, Submission, Card, BlackCard } from './types'
import { createId } from '@paralleldrive/cuid2'

export function chooseFirstCzar(activePlayerCount: number): number {
  return randomInt(0, activePlayerCount)
}

export async function buildDecks(code: string, packIds: string[]): Promise<void> {
  const black = await db.select().from(blackCards).where(inArray(blackCards.packId, packIds))
  const white = await db.select().from(whiteCards).where(inArray(whiteCards.packId, packIds))
  const blackIds = shuffle(black.map((b) => b.id))
  const whiteIds = shuffle(white.map((w) => w.id))
  await state.pushDeck(code, 'black', blackIds)
  await state.pushDeck(code, 'white', whiteIds)
  engineLogger.info({ code, black: blackIds.length, white: whiteIds.length }, 'decks built')
}

export async function dealStartingHands(
  code: string,
  playerIds: string[],
): Promise<Record<string, string[]>> {
  const hands: Record<string, string[]> = {}
  for (const pid of playerIds) {
    const cards = await state.drawCards(code, 'white', 10)
    await state.setHand(code, pid, cards)
    hands[pid] = cards
  }
  return hands
}

export async function startGame(code: string): Promise<void> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) throw new Error('session not found')
  const config = session.config as GameConfig

  await buildDecks(code, config.packs)

  const activePlayers = await db
    .select()
    .from(gamePlayers)
    .where(
      sql`${gamePlayers.sessionId} = ${session.id} AND ${gamePlayers.role} = 'player' AND ${gamePlayers.status} = 'active'`,
    )

  // Insert Rando if rule active
  if (config.rules.includes('rando')) {
    const [rando] = await db
      .insert(gamePlayers)
      .values({
        sessionId: session.id,
        username: 'Rando Cardrissian',
        role: 'player',
        status: 'active',
        isRando: true,
      })
      .returning()
    activePlayers.push(rando)
  }

  await state.setCzarOrder(
    code,
    activePlayers.map((p) => p.id),
  )
  await dealStartingHands(
    code,
    activePlayers.map((p) => p.id),
  )

  // Mark first Czar
  const firstCzarIdx = chooseFirstCzar(activePlayers.length)
  await db.update(gameSessions).set({ status: 'active' }).where(eq(gameSessions.id, session.id))

  engineLogger.info({ code, firstCzarIdx, players: activePlayers.length }, 'game started')
  return // Round 1 setup happens via startRound (next task)
}
```

- [x] **Step 3: Run test**

```bash
pnpm test src/lib/game-engine.test.ts
```

Expected: PASS.

- [x] **Step 4: Commit**

```bash
git add src/lib/game-engine.ts src/lib/game-engine.test.ts
git commit -m "feat: game engine — startGame, buildDecks, dealStartingHands, chooseFirstCzar"
```

### Task 8.2: Round lifecycle (startRound, submitCards, pickWinner, endRound) — ✅ DONE

**Files:**

- Modify: `src/lib/game-engine.ts` (extend)

- [x] **Step 1: Add round functions**

Append to `game-engine.ts`:

```ts
export async function startRound(
  code: string,
  round: number,
): Promise<{ prompt: BlackCard; czarId: string | null }> {
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) throw new Error('session not found')
  const config = session.config as GameConfig

  const blackIds = await state.drawCards(code, 'black', 1)
  if (blackIds.length === 0) {
    await endGame(code, 'deck_exhausted')
    throw new Error('deck_exhausted')
  }
  const [black] = await db.select().from(blackCards).where(eq(blackCards.id, blackIds[0]))
  if (!black) throw new Error('black card missing')

  let czarId: string | null = null
  if (!config.rules.includes('godmode')) {
    const order = await state.getCzarOrder(code)
    const allPlayers = await state.getAllPlayers(code)
    const activeOrder = order.filter((pid) => {
      const p = allPlayers.find((x) => x.id === pid)
      return p && p.status === 'active' && !p.isRando
    })
    czarId = activeOrder[(round - 1) % activeOrder.length] ?? null
  }

  // Persist round
  await db.insert(gamePlayers).values([]).onConflictDoNothing() // no-op placeholder
  await state.publishEvent(code, {
    type: 'round_started',
    round,
    prompt: { id: black.id, text: black.text, pick: black.pick },
    czarId,
  })

  engineLogger.info({ code, round, czarId, blackCardId: black.id }, 'round started')
  return { prompt: { id: black.id, text: black.text, pick: black.pick } as BlackCard, czarId }
}

export async function submitCards(
  code: string,
  playerId: string,
  cardIds: string[],
): Promise<void> {
  const allCards = await db.select().from(whiteCards).where(inArray(whiteCards.id, cardIds))
  const fills: Card[] = cardIds.map((id) => {
    const c = allCards.find((x) => x.id === id)
    if (!c) throw new Error(`card ${id} not found`)
    return { id: c.id, text: c.text }
  })
  const submission: Submission = {
    submissionId: createId(),
    fills,
    playerId,
  }
  await state.setSubmission(code, playerId, submission)
  await state.removeFromHand(code, playerId, cardIds)
  await state.publishEvent(code, { type: 'player_played', playerId })
}

export async function pickWinner(
  code: string,
  czarId: string,
  submissionId: string,
): Promise<void> {
  const submissions = await state.getSubmissions(code)
  const entry = Object.entries(submissions).find(([, s]) => s.submissionId === submissionId)
  if (!entry) throw new Error('submission not found')
  const [winnerPlayerId] = entry

  // Increment score
  const winner = await state.getPlayer(code, winnerPlayerId)
  if (!winner) throw new Error('winner not found')
  await state.updatePlayer(code, winnerPlayerId, { score: winner.score + 1 })

  const players = await state.getAllPlayers(code)
  const scores = players.map((p) => ({
    playerId: p.id,
    username: p.username,
    score: p.id === winnerPlayerId ? p.score + 1 : p.score,
    isJudge: p.id === czarId,
    isRando: p.isRando,
  }))

  await state.publishEvent(code, {
    type: 'round_won',
    winnerId: winnerPlayerId,
    submissionId,
    scores,
  })

  await endRound(code, [
    winnerPlayerId,
    ...Object.keys(submissions).filter((p) => p !== winnerPlayerId),
  ])
}

export async function endRound(code: string, submitterIds: string[]): Promise<void> {
  // Move submissions to discard
  const submissions = await state.getSubmissions(code)
  const allFillIds: string[] = []
  for (const s of Object.values(submissions)) for (const f of s.fills) allFillIds.push(f.id)
  await state.discardCards(code, 'white', allFillIds)

  // Refill hands
  const handsRefilled: Record<string, string[]> = {}
  for (const pid of submitterIds) {
    const current = await state.getHand(code, pid)
    const needed = 10 - current.length
    if (needed > 0) {
      const drawn = await state.drawCards(code, 'white', needed)
      if (drawn.length > 0) await redis.sadd(`game:${code}:hand:${pid}`, ...drawn)
      handsRefilled[pid] = [...current, ...drawn]
    } else handsRefilled[pid] = current
  }

  // Clear submissions
  await redis.del(`${KEYS.round(code)}:submissions`)

  // Activate queued players
  const players = await state.getAllPlayers(code)
  const activated: string[] = []
  for (const p of players) {
    if (p.status === 'queued') {
      await state.updatePlayer(code, p.id, { status: 'active' })
      activated.push(p.id)
      const dealt = await state.drawCards(code, 'white', 10)
      await state.setHand(code, p.id, dealt)
      handsRefilled[p.id] = dealt
    }
  }

  await state.publishEvent(code, { type: 'round_end', activatedPlayers: activated, handsRefilled })

  // Check win condition
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
  if (!session) return
  const config = session.config as GameConfig
  const refreshed = await state.getAllPlayers(code)
  const winner = refreshed.find((p) => p.score >= config.roundsToWin)
  if (winner) {
    const mode: GameOverMode = winner.isRando ? 'rando_won' : 'normal'
    await endGame(code, mode, winner.id)
  }
}

export async function endGame(code: string, mode: GameOverMode, winnerId?: string): Promise<void> {
  const players = await state.getAllPlayers(code)
  const finalScores = players.map((p) => ({
    playerId: p.id,
    username: p.username,
    score: p.score,
    isJudge: false,
    isRando: p.isRando,
  }))

  await db
    .update(gameSessions)
    .set({ status: 'ended', endedAt: new Date(), endMode: mode, winnerPlayerId: winnerId ?? null })
    .where(eq(gameSessions.code, code))

  await state.publishEvent(code, { type: 'game_over', finalScores, winnerId: winnerId ?? '', mode })
  engineLogger.info({ code, mode, winnerId }, 'game over')
}
```

(You will need to import `redis` and `KEYS` at the top of `game-engine.ts`.)

- [x] **Step 2: Typecheck**

```bash
pnpm typecheck
```

- [x] **Step 3: Commit**

```bash
git add src/lib/game-engine.ts
git commit -m "feat: game engine — startRound, submitCards, pickWinner, endRound, endGame"
```

### Task 8.3: House rules — modal mechanics — ✅ DONE

**Files:**

- Modify: `src/lib/game-engine.ts` (add mode-specific resolution paths)

- [x] **Step 1: Add mode handlers**

Add functions for:

- **God Is Dead** (`resolveByVote`) — collect votes from all players, find majority, re-vote on tie ×2 then random
- **Survival of the Fittest** (`startElimination`, `eliminateSubmission`) — turn-based elimination
- **Serious Business** (`rankSubmissions`) — Czar provides ordered top-3, server applies +3/+2/+1

Each must end by calling `endRound(code, submitterIds)` to share the uniform termination path.

Pseudocode:

```ts
export async function castVote(code: string, voterId: string, submissionId: string): Promise<void> {
  // append to round's voteTally hash field; check if all players voted; if so, resolve
}

export async function eliminateSubmission(
  code: string,
  byPlayerId: string,
  submissionId: string,
): Promise<void> {
  // mark submission.eliminated=true; advance elimination turn; if 1 remains, that player wins
}

export async function applyRanking(code: string, czarId: string, ranking: string[]): Promise<void> {
  // ranking: array of submissionIds, [0]=1st, [1]=2nd, [2]=3rd
  // award 3/2/1 points; publish round_ranked; endRound
}
```

Full implementations follow the same pattern as `pickWinner` — full code is left to be written per SPEC.md § House Rules. (Plan note: each function is ~30-50 lines; pattern matches `pickWinner`.)

- [x] **Step 2: Gambling, redraw, confess_discard, packing_heat hooks**

Add small helpers:

- `gamble(code, playerId)` — check score ≥ 1, decrement, allow second submission
- `redraw(code, playerId)` — check score ≥ 1, decrement, refill hand
- `confessDiscard(code, playerId, cardId)` — check discardsUsed < 3, increment, replace card
- `applyPackingHeat(code, playerIds, pick)` — deal +1 white card when pick is 2

- [x] **Step 3: Commit**

```bash
git add src/lib/game-engine.ts
git commit -m "feat: house rule mechanics — voting, elimination, ranking, gamble, redraw, confess_discard"
```

---

## Phase 9 — WebSocket Server

### Task 9.1: WebSocket handler — ✅ DONE

**Files:**

- Create: `src/ws/auth.ts`
- Create: `src/ws/handler.ts`
- Create: `src/routes/api/games/$code/ws.ts`

- [x] **Step 1: Create `src/ws/auth.ts`** to validate first `auth` message

```ts
import { verifySessionToken } from '~/lib/session-token'
import { getPlayer } from '~/lib/game-state'

export async function authenticateSocket(
  code: string,
  message: { type: string; sessionToken?: string; anonId?: string },
): Promise<{ playerId: string; anonId: string } | null> {
  if (message.type !== 'auth' || !message.sessionToken) return null
  try {
    const payload = await verifySessionToken(message.sessionToken)
    if (payload.roomCode !== code) return null
    const player = await getPlayer(code, payload.playerId)
    if (!player || player.status === 'dropped') return null
    return { playerId: payload.playerId, anonId: message.anonId ?? '' }
  } catch {
    return null
  }
}
```

- [x] **Step 2: Create `src/ws/handler.ts`** with full event router

```ts
import type { Peer } from 'crossws'
import { wsLogger } from '~/lib/logger'
import { authenticateSocket } from './auth'
import { getSubscriber, KEYS } from '~/lib/redis'
import * as engine from '~/lib/game-engine'
import * as state from '~/lib/game-state'
import { TIMING } from '~/lib/timing'
import type { ClientToServerEvent, ServerToClientEvent } from '~/lib/types'

type PeerCtx = { code: string; playerId?: string; anonId?: string; lastPing: number }
const peerContext = new WeakMap<Peer, PeerCtx>()
const roomPeers = new Map<string, Set<Peer>>()
const roomSubs = new Map<string, ReturnType<typeof getSubscriber>>()

function send(peer: Peer, event: ServerToClientEvent): void {
  try {
    peer.send(JSON.stringify(event))
  } catch (err) {
    wsLogger.warn({ err }, 'send failed')
  }
}

function broadcast(code: string, event: ServerToClientEvent): void {
  const peers = roomPeers.get(code)
  if (!peers) return
  for (const peer of peers) send(peer, event)
}

async function ensureSubscriber(code: string): Promise<void> {
  if (roomSubs.has(code)) return
  const sub = getSubscriber(KEYS.channel(code))
  sub.subscribe(KEYS.channel(code))
  sub.on('message', (_channel, msg) => {
    try {
      const event = JSON.parse(msg) as ServerToClientEvent
      broadcast(code, event)
    } catch (err) {
      wsLogger.error({ err }, 'bad pub/sub payload')
    }
  })
  roomSubs.set(code, sub)
}

export const wsRouter = {
  async open(peer: Peer, code: string) {
    peerContext.set(peer, { code, lastPing: Date.now() })
    if (!roomPeers.has(code)) roomPeers.set(code, new Set())
    roomPeers.get(code)!.add(peer)
    await ensureSubscriber(code)
    wsLogger.info({ code }, 'peer opened')
  },

  async message(peer: Peer, raw: string) {
    let msg: ClientToServerEvent
    try {
      msg = JSON.parse(raw)
    } catch {
      return send(peer, { type: 'error', code: 'internal_error', message: 'bad JSON' })
    }

    const ctx = peerContext.get(peer)
    if (!ctx) return

    // Auth handshake
    if (!ctx.playerId) {
      if (msg.type !== 'auth')
        return send(peer, { type: 'error', code: 'not_authorized', message: 'auth first' })
      const auth = await authenticateSocket(ctx.code, msg)
      if (!auth)
        return send(peer, { type: 'auth_error', code: 'invalid_token', message: 'invalid token' })
      ctx.playerId = auth.playerId
      ctx.anonId = auth.anonId
      send(peer, { type: 'auth_ok' })
      // Update player status from grace → active if needed
      const player = await state.getPlayer(ctx.code, auth.playerId)
      if (player?.status === 'grace') {
        await state.updatePlayer(ctx.code, auth.playerId, { status: 'active' })
        await state.clearGrace(ctx.code, auth.playerId)
      }
      return
    }

    ctx.lastPing = Date.now()

    switch (msg.type) {
      case 'ping':
        return send(peer, { type: 'pong' })
      case 'rejoin': {
        // Build state_snapshot from Redis
        // (Stub for now; flesh out per SessionState shape)
        return
      }
      case 'play':
        return engine.submitCards(ctx.code, ctx.playerId, msg.cardIds)
      case 'gamble':
        return engine.gamble(ctx.code, ctx.playerId)
      case 'pick': {
        const player = await state.getPlayer(ctx.code, ctx.playerId)
        if (!player) return
        return engine.pickWinner(ctx.code, ctx.playerId, msg.submissionId)
      }
      case 'vote':
        return engine.castVote(ctx.code, ctx.playerId, msg.submissionId)
      case 'eliminate':
        return engine.eliminateSubmission(ctx.code, ctx.playerId, msg.submissionId)
      case 'rank':
        return engine.applyRanking(ctx.code, ctx.playerId, msg.ranking)
      case 'redraw':
        return engine.redraw(ctx.code, ctx.playerId)
      case 'confess_discard':
        return engine.confessDiscard(ctx.code, ctx.playerId, msg.cardId)
      case 'leave': {
        await state.updatePlayer(ctx.code, ctx.playerId, { status: 'dropped' })
        broadcast(ctx.code, { type: 'player_left', playerId: ctx.playerId })
        return
      }
    }
  },

  async close(peer: Peer) {
    const ctx = peerContext.get(peer)
    if (!ctx) return
    const peers = roomPeers.get(ctx.code)
    peers?.delete(peer)
    if (ctx.playerId) {
      // Grace window
      await state.updatePlayer(ctx.code, ctx.playerId, { status: 'grace' })
      await state.setGrace(ctx.code, ctx.playerId, TIMING.GRACE_WINDOW_MS)
      setTimeout(async () => {
        const player = await state.getPlayer(ctx.code, ctx.playerId!)
        if (player?.status === 'grace') {
          await state.updatePlayer(ctx.code, ctx.playerId!, { status: 'dropped' })
          broadcast(ctx.code, { type: 'player_left', playerId: ctx.playerId! })
        }
      }, TIMING.GRACE_WINDOW_MS + 100)
    }
    peerContext.delete(peer)
    wsLogger.info({ code: ctx.code, playerId: ctx.playerId }, 'peer closed')
  },
}
```

- [x] **Step 3: Create the route file** `src/routes/api/games/$code/ws.ts` and wire crossws

(TanStack Start + h3 WebSocket wiring — exact API depends on Vinxi version. Follow the latest TanStack Start docs at the time of implementation. The route should mount `wsRouter` against the `:code` param.)

- [x] **Step 4: Smoke-test WebSocket**

Run dev server. Use `wscat` or browser console:

```js
const ws = new WebSocket('ws://localhost:3000/api/games/TESTCODE/ws')
ws.onopen = () => ws.send(JSON.stringify({ type: 'ping' }))
ws.onmessage = (e) => console.log(e.data)
```

Expected: server replies with `{"type":"error","code":"not_authorized",...}` (because no auth was sent first).

- [x] **Step 5: Commit**

```bash
git add src/ws/ src/routes/api/games/$code/ws.ts
git commit -m "feat: WebSocket server with auth handshake, event router, grace window"
```

---

## Phase 10 — Frontend WS Integration

### Task 10.1: useSession hook — ✅ DONE

**Files:**

- Create: `src/hooks/useSession.ts`

```ts
import { useCallback, useEffect, useState } from 'react'
import type { CabSession } from '~/lib/types'

const KEY = 'cab_session'

export function useSession() {
  const [session, setSessionState] = useState<CabSession | null>(() => {
    if (typeof window === 'undefined') return null
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as CabSession) : null
  })

  const setSession = useCallback((s: CabSession | null) => {
    setSessionState(s)
    if (typeof window === 'undefined') return
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
  }, [])

  return { session, setSession }
}
```

- [x] **Step 1: Commit**

```bash
git add src/hooks/useSession.ts
git commit -m "feat: useSession hook for localStorage-backed cab_session"
```

### Task 10.2: useGameSocket hook — ✅ DONE

**Files:**

- Create: `src/hooks/useGameSocket.ts`

```ts
import { useEffect, useRef, useState } from 'react'
import { TIMING } from '~/lib/timing'
import type { ServerToClientEvent, ClientToServerEvent } from '~/lib/types'

export function useGameSocket(code: string | null, sessionToken: string | null, anonId: string) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<((event: ServerToClientEvent) => void)[]>([])
  const [connected, setConnected] = useState(false)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    if (!code || !sessionToken) return
    let backoffMs = 1000
    let pingTimer: ReturnType<typeof setInterval> | null = null

    function connect() {
      const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/games/${code}/ws`)
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        ws.send(
          JSON.stringify({ type: 'auth', sessionToken, anonId } satisfies ClientToServerEvent),
        )
        ws.send(JSON.stringify({ type: 'rejoin' } satisfies ClientToServerEvent))
        backoffMs = 1000
        pingTimer = setInterval(
          () => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'ping' })),
          TIMING.KEEPALIVE_INTERVAL_MS,
        )
      }
      ws.onmessage = (e) => {
        let event: ServerToClientEvent
        try {
          event = JSON.parse(e.data)
        } catch {
          return
        }
        if (event.type === 'auth_ok') setAuthed(true)
        for (const h of handlersRef.current) h(event)
      }
      ws.onclose = () => {
        setConnected(false)
        setAuthed(false)
        if (pingTimer) clearInterval(pingTimer)
        setTimeout(connect, backoffMs)
        backoffMs = Math.min(30_000, backoffMs * 2)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      wsRef.current?.close()
      if (pingTimer) clearInterval(pingTimer)
    }
  }, [code, sessionToken, anonId])

  const send = (event: ClientToServerEvent) => wsRef.current?.send(JSON.stringify(event))
  const on = (handler: (e: ServerToClientEvent) => void) => {
    handlersRef.current.push(handler)
    return () => {
      handlersRef.current = handlersRef.current.filter((h) => h !== handler)
    }
  }

  return { connected, authed, send, on }
}
```

- [x] **Step 1: Commit**

```bash
git add src/hooks/useGameSocket.ts
git commit -m "feat: useGameSocket with auto-reconnect and keepalive"
```

### Task 10.3: Wire Create / Join / Lobby / Session to real HTTP + WS — ✅ DONE

**Files:**

- Modify: `src/routes/games/create.tsx`
- Modify: `src/routes/games/join.tsx`
- Modify: `src/routes/games/$code/lobby.tsx`
- Modify: `src/routes/games/$code/session.tsx`

- [x] **Step 1: Create — POST /api/games on submit, store CabSession, navigate to lobby**

In Create's onSubmit:

```tsx
const anonId = getOrCreateAnonId()
const res = await fetch('/api/games', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, anonId, config }),
})
const { roomCode, playerId, sessionToken } = await res.json()
setSession({ roomCode, playerId, sessionToken, username, role: 'player', anonId })
navigate({ to: `/games/${roomCode}/lobby` })
```

- [x] **Step 2: Join — similar pattern**

- [x] **Step 3: Lobby — open WS, listen for `player_joined` / `game_started`**

When `game_started` arrives, navigate to `/games/$code/session`.

- [x] **Step 4: Session — listen for all phase events; remove stub `setTimeout` simulations**

- [x] **Step 5: Test full flow with 2 browser tabs**

Open `/games/create` in tab A, create game. Copy code. Open `/games/join` in tab B, paste code, join. Both navigate to lobby. Click Start in tab A. Both navigate to session.

- [x] **Step 6: Commit**

```bash
git add src/routes/
git commit -m "feat: wire frontend screens to real HTTP API and WebSocket"
```

---

## Phase 11 — Real Stats Aggregation

### Task 11.1: Replace mocked stats — ✅ DONE

**Files:**

- Modify: `src/routes/api/stats.ts`

- [x] **Step 1: Implement real Postgres aggregations per SPEC.md § Aggregations for Stats**

Use Drizzle SQL with raw queries where needed (JSONB unnest for top cards).

- [x] **Step 2: Test against seeded DB**

```bash
curl http://localhost:3000/api/stats | jq
```

- [x] **Step 3: Commit**

```bash
git add src/routes/api/stats.ts
git commit -m "feat: real stats aggregations from Postgres"
```

---

## Phase 12 — Sweeper Job

### Task 12.1: Stale-game sweeper — ✅ DONE (server-boot.ts wired from healthz route; guards double-start)

**Files:**

- Create: `src/lib/sweeper.ts`
- Modify: `src/ssr.tsx` (start sweeper at boot)

- [x] **Step 1: Create sweeper**

```ts
import cron from 'node-cron'
import { db } from '~/db'
import { gameSessions } from '~/db/schema'
import { redis, KEYS } from './redis'
import { sweeperLogger } from './logger'
import { sql, and, inArray } from 'drizzle-orm'

export async function sweepOnce(): Promise<number> {
  const candidates = await db
    .select()
    .from(gameSessions)
    .where(
      and(
        inArray(gameSessions.status, ['active', 'paused']),
        sql`${gameSessions.lastActivityAt} < now() - interval '6 hours'`,
      ),
    )

  let cleaned = 0
  for (const session of candidates) {
    const playersKey = KEYS.players(session.code)
    const count = await redis.hlen(playersKey)
    if (count === 0) {
      await db
        .update(gameSessions)
        .set({ status: 'abandoned', endMode: 'abandoned', endedAt: new Date() })
        .where(sql`${gameSessions.id} = ${session.id}`)
      cleaned++
    }
  }
  if (cleaned > 0) sweeperLogger.info({ cleaned }, 'sweep complete')
  return cleaned
}

export function startSweeper(): void {
  cron.schedule('*/30 * * * *', () => {
    sweepOnce().catch((err) => sweeperLogger.error({ err }, 'sweep failed'))
  })
  sweeperLogger.info('sweeper scheduled')
}
```

- [x] **Step 2: Start sweeper from server entry** _(via `src/lib/server-boot.ts` called from healthz route — TanStack Start has no `src/ssr.tsx` entry point)_

In `src/lib/server-boot.ts`:

```ts
import { startSweeper } from './sweeper'
import { startKeepaliveEnforcer } from '~/ws/handler'
let started = false
export function ensureServerBoot(): void {
  if (started || process.env['NODE_ENV'] === 'test') return
  started = true
  startSweeper()
  startKeepaliveEnforcer()
}
```

- [x] **Step 3: Commit**

```bash
git add src/lib/sweeper.ts src/lib/server-boot.ts src/routes/api/healthz.ts
git commit -m "feat: node-cron sweeper for stale games"
```

---

## Phase 13 — Playwright E2E Tests

### Task 13.1: Test helpers — ✅ DONE

**Files:**

- Create: `tests/fixtures/handles.ts`
- Create: `tests/fixtures/expected-outcomes.ts`
- Create: `tests/helpers.ts`

- [x] **Step 1: Create handles fixture**

```ts
export const HANDLES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank'] as const
```

- [x] **Step 2: Create helpers — createGame, joinGame, getPlayerContext**

(Multi-context Playwright pattern: each player is a separate `BrowserContext` with its own localStorage. Helpers wrap fetch+navigate.)

- [x] **Step 3: Commit**

```bash
git add tests/fixtures/ tests/helpers.ts
git commit -m "test: add Playwright helpers and handle fixtures"
```

### Task 13.2: Full 6-player 5-win golden-path test — ✅ DONE

**Files:**

- Create: `tests/e2e/full-game.spec.ts`

- [x] **Step 1: Implement per SPEC.md § Core flows golden path**

Test:

- 6 browser contexts (host + 5 players)
- Host creates game with `roundsToWin: 5`, `maxPlayers: 6`, Core pack only, no house rules
- Other 5 join via room code
- Host clicks Start; all 6 land on session
- Loop until `cab_game_over`: identify Czar, non-Czars submit (first hand card N times for pick N), Czar starts reveal then picks first revealed
- Assert: ≤20 rounds, winner has 5 points
- All navigate to /end
- localStorage cleared after Go home

- [x] **Step 2: Run**

```bash
pnpm test:e2e tests/e2e/full-game.spec.ts
```

Expected: PASS.

- [x] **Step 3: Commit**

```bash
git add tests/e2e/full-game.spec.ts
git commit -m "test: full 6-player 5-win golden-path E2E"
```

### Task 13.3: Reconnect tests — ✅ DONE

**Files:**

- Create: `tests/e2e/reconnect.spec.ts`

- [x] **Step 1: Implement five scenarios per spec**

- Player refresh mid-picking → reconnects with hand
- Czar refresh during reveal → can still pick winner
- Player drop and rejoin within grace → no state loss
- Player drop > 30s → removed
- Czar drop > 30s during judging → auto-pick

- [x] **Step 2: Commit**

```bash
git add tests/e2e/reconnect.spec.ts
git commit -m "test: reconnect scenarios"
```

### Task 13.4: Multi-blank tests — ✅ DONE

**Files:**

- Create: `tests/e2e/multi-blank.spec.ts`

- [x] **Step 1: Implement per spec**

Cover pick-2 + pick-3, multi-card badge ordering, Czar's view layout.

- [x] **Step 2: Commit**

### Task 13.5: Mid-game join tests — ✅ DONE

**Files:**

- Create: `tests/e2e/mid-game-join.spec.ts`

### Task 13.6: House rules tests — ✅ DONE

**Files:**

- Create: `tests/e2e/house-rules.spec.ts`

Cover each rule per spec. 8 sub-tests.

### Task 13.7: Mobile + a11y tests — ✅ DONE

**Files:**

- Create: `tests/e2e/mobile.spec.ts`
- Create: `tests/e2e/a11y.spec.ts`

Mobile viewports 375×667 and 414×896. A11y: keyboard navigation, aria attributes, live region announcements.

Commit each task individually with `test: <description>`.

---

## Phase 14 — Docker & Deployment

### Task 14.1: Dockerfile — ✅ DONE

**Files:**

- Create: `Dockerfile`
- Create: `.dockerignore`

- [x] **Step 1: Create `.dockerignore`**

```
node_modules
.git
.output
.vinxi
tests
docs
playwright-report
test-results
.env
.env.*
*.md
!CLAUDE.md
```

- [x] **Step 2: Create multi-stage Dockerfile**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS run
WORKDIR /app
RUN corepack enable && addgroup -g 1001 cab && adduser -D -u 1001 -G cab cab
COPY --from=build --chown=cab:cab /app/.output ./.output
COPY --from=build --chown=cab:cab /app/package.json ./package.json
COPY --from=build --chown=cab:cab /app/drizzle ./drizzle
COPY --from=build --chown=cab:cab /app/node_modules ./node_modules
USER cab
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
```

- [x] **Step 3: Build locally**

```bash
docker build -t cab:dev .
```

Expected: build succeeds.

- [x] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "chore: multi-stage Dockerfile for production builds"
```

### Task 14.2: Production compose override — ✅ DONE

**Files:**

- Modify: `docker-compose.yml` (add app service)
- Create: `docker-compose.prod.yml`

- [x] **Step 1: Add app service to `docker-compose.yml`**

```yaml
app:
  build: .
  container_name: cab_app
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
  environment:
    DATABASE_URL: postgres://cab:cab@postgres:5432/cab_dev
    REDIS_URL: redis://redis:6379/0
    SESSION_SECRET: ${SESSION_SECRET}
    PORT: 3000
    NODE_ENV: production
    AXIOM_TOKEN: ${AXIOM_TOKEN:-}
    AXIOM_DATASET: ${AXIOM_DATASET:-cab-prod}
    POSTHOG_API_KEY: ${POSTHOG_API_KEY:-}
    POSTHOG_HOST: ${POSTHOG_HOST:-https://us.i.posthog.com}
  ports:
    - '127.0.0.1:3000:3000'
  healthcheck:
    test: ['CMD', 'wget', '-qO-', 'http://localhost:3000/api/healthz']
    interval: 10s
    timeout: 5s
    retries: 5
```

- [x] **Step 2: Create `docker-compose.prod.yml`**

```yaml
services:
  app:
    restart: unless-stopped
    mem_limit: 512m
  postgres:
    restart: unless-stopped
    mem_limit: 1g
  redis:
    restart: unless-stopped
    mem_limit: 256m
```

- [x] **Step 3: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml
git commit -m "chore: docker-compose with app service and prod override"
```

---

## Phase 15 — Final Polish

### Task 15.1: README — ✅ DONE

**Files:**

- Create: `README.md`

- [x] **Step 1: Write minimal README pointing to SPEC.md and CLAUDE.md, with quickstart commands**

- [x] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with quickstart"
```

### Task 15.2: Audit PostHog event coverage — ✅ DONE

- [x] **Step 1: Grep for every event in SPEC.md § Event taxonomy**

Added all missing events. `cab_player_skipped` added in `expireRoundTimer` in `src/lib/game-engine.ts`, alongside `player_skipped`. All other events were added in the previous session.

- [x] **Step 2: Add `cab_player_skipped`** — implemented in `expireRoundTimer`

- [x] **Step 3: Commit**

### Task 15.3: Sourcemap upload for PostHog — ✅ DONE

**Files:**

- Modify: `Dockerfile` (run `posthog-cli sourcemap upload` after build)

- [x] **Step 1: Add sourcemap upload step in Dockerfile build stage**

```dockerfile
ARG POSTHOG_PERSONAL_API_KEY
ARG POSTHOG_API_KEY
RUN if [ -n "$POSTHOG_PERSONAL_API_KEY" ]; then \
      pnpm dlx posthog-cli sourcemap upload --directory .output ; \
    fi
```

- [x] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "chore: upload sourcemaps to PostHog during prod build"
```

---

## Spec Coverage Self-Review

Verify each section of `SPEC.md` is covered by a task in this plan.

| Spec section                                                                                                                                    | Plan task                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Overview                                                                                                                                        | Phase 0                                    |
| Tech Stack                                                                                                                                      | Phase 0                                    |
| Design reference notes                                                                                                                          | Phase 4                                    |
| Auth & session lifecycle (join, reconnect, logout, security)                                                                                    | Task 2.4 + Phase 6 + 10.1 + 10.2           |
| HTTP API (all endpoints)                                                                                                                        | Phase 6 (6.1–6.7)                          |
| Routes (all 7 UI routes)                                                                                                                        | Phase 4 (4.4–4.10)                         |
| Visual Design System (tokens, fonts, components, animation, prompt blank rendering, a11y, mobile)                                               | Task 0.4 + 4.1 + 13.7                      |
| Screens (Home, Create, Join, Lobby, Session, Stats, End)                                                                                        | Phase 4                                    |
| State Management (GameContext, localStorage, multi-game blocking, settings immutability)                                                        | Task 4.3 + 10.1 + 10.3                     |
| Type Definitions                                                                                                                                | Task 1.1                                   |
| WebSocket Protocol (events, ordering, atomicity, dedup, reconnect, disconnect, keepalive)                                                       | Phase 9 + Task 10.2                        |
| Game Rules Engine (core loop, gambling, czar selection, RNG, card pool, deck exhaustion, timer expiry, submission shuffling, all 8 house rules) | Phase 8 + Task 2.2                         |
| Spectator permissions                                                                                                                           | Phase 9 (server-side gating in WS handler) |
| Mid-game join                                                                                                                                   | Task 8.2 endRound + Task 10.3              |
| Card data seeding                                                                                                                               | Task 5.4                                   |
| Database schema + indexes + sweeper                                                                                                             | Phase 3 + Phase 12                         |
| Redis state shape                                                                                                                               | Task 5.2 + 7.1                             |
| Room code generation                                                                                                                            | Task 2.3                                   |
| E2E Testing (core, reconnect, multi-blank, mid-game, house rules, base mechanics, end, mobile, a11y, infrastructure)                            | Phase 13                                   |
| Docker Compose / Deployment                                                                                                                     | Task 0.7 + Phase 14                        |
| Logging (pino + Axiom)                                                                                                                          | Task 5.1                                   |
| Product Analytics, Session Replay & Error Tracking (PostHog)                                                                                    | Task 5.5 + 5.6 + 6.2 + 15.2 + 15.3         |
| Randomness                                                                                                                                      | Task 2.2 + 8.1                             |
| Environment variables                                                                                                                           | Task 0.6 (.env.example) + 14.2 (compose)   |
| Project file structure                                                                                                                          | Created across all phases                  |
| Quick Reference commands                                                                                                                        | Task 0.1 + README (15.1)                   |
| Non-negotiable conventions                                                                                                                      | Honoured throughout                        |

**Gaps to watch in implementation:**

- Task 8.3 (modal rule mechanics) is sketched — the implementation engineer must flesh out God Is Dead, Survival, Serious Business resolution following the same shape as `pickWinner` + `endRound`.
- Task 9.1's `rejoin` handler is a stub (`return`); the engineer must build `state_snapshot` from `getAllPlayers + getSubmissions + currentRound` etc.
- TanStack Start's WebSocket route binding is API-version-sensitive — verify against the latest TanStack Start docs at implementation time.
- Drizzle's partial unique index workaround (Task 3.2) may become unnecessary if Drizzle releases native support before implementation starts.

If you find an additional spec requirement that no task covers during implementation, add a task before continuing.
