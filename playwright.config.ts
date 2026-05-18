import { defineConfig, devices } from '@playwright/test'

// When CAB_E2E_BASE points at an already-running server (e.g. the Docker
// stack) Playwright targets it directly and skips its own webServer.
// Otherwise it builds + starts the production server — `pnpm dev` (Vite)
// no longer serves WebSockets; only the srvx prod entry does.
const externalBase = process.env.CAB_E2E_BASE

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',
  use: {
    baseURL: externalBase ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(externalBase
    ? {}
    : {
        webServer: {
          command: 'pnpm build && pnpm start',
          url: 'http://localhost:3000/api/healthz',
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
          env: {
            DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://cab:cab@localhost:5432/cab_test',
            REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379/1',
            SESSION_SECRET: 'test-secret-min-32-chars-test-test-test',
            CAB_RNG_SEED: 'test-seed-2026',
            PORT: '3000',
            // NOT 'production': rate-limit.ts enforces only when
            // NODE_ENV==='production', and the suite creates >5 games
            // serially from one IP — prod's create budget (5/3600s) then
            // 429s every test past ~#16. rate-limit.ts documents that the
            // suite must pass through; this is the env that honours it.
            // Nothing else in the suite needs prod mode (logger.ts is the
            // only other gate and is a no-op without an Axiom token).
            NODE_ENV: 'test',
          },
        },
      }),
})
