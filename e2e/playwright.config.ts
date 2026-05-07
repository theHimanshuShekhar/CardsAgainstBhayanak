import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      ROUND_DELAY_MS: "1000",
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://cab:cab_secret@localhost:5432/cardsagainstbhayanak",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
      JWT_SECRET: process.env.JWT_SECRET ?? "dev_secret_change_in_production",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
