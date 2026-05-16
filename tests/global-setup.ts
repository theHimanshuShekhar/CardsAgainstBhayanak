import { execSync } from 'node:child_process'

// Pushes the Drizzle schema (idempotent) and seeds card packs once.
// Seeding hits the external REST API, so we only do it when the packs
// table is empty — keeps repeated runs fast.
export default async function globalSetup(): Promise<void> {
  if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL required for E2E')

  execSync('pnpm exec drizzle-kit push --force', {
    stdio: 'inherit',
    env: process.env,
  })

  const { db } = await import('../src/db')
  const { packs } = await import('../src/db/schema')
  const { count } = await import('drizzle-orm')
  const [row] = await db.select({ value: count() }).from(packs)
  if (Number(row?.value ?? 0) === 0) {
    const { seedPacks } = await import('../src/lib/seed')
    await seedPacks()
  }
}
