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
