import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import postgres from 'postgres'
import Redis from 'ioredis'

const exec = promisify(execFile)

// Replay recovery must never inspect rooms from the main browser suite.
// Own both backing stores, publishing only randomly assigned loopback ports.
export async function replayInfrastructure() {
  const containers: string[] = []
  let database: ReturnType<typeof postgres> | undefined
  let cache: Redis | undefined
  async function close() {
    cache?.disconnect()
    const cleanup = await Promise.allSettled([
      database?.end({ timeout: 1 }),
      ...containers.map(async (name) => {
        try {
          await exec('docker', ['rm', '-f', name])
        } catch (error) {
          if (!String(error).includes('No such container')) throw error
        }
      }),
    ])
    const errors = cleanup.filter((result) => result.status === 'rejected')
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        'Replay fixture cleanup failed',
      )
  }
  async function container(image: string, internalPort: number, args: string[] = []) {
    const name = `cab-seeded-replay-${randomUUID()}`
    // Register before creation so even a partially successful docker run is
    // cleaned up. Names are unique and cannot target any pre-existing service.
    containers.push(name)
    await exec('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      'cab.test=seeded-replay',
      '-p',
      `127.0.0.1::${internalPort}`,
      ...args,
      image,
    ])
    const published = await exec('docker', ['port', name, `${internalPort}/tcp`])
    return published.stdout.trim()
  }
  try {
    const password = randomUUID()
    const pgAddress = await container('postgres:17-alpine', 5432, [
      '-e',
      'POSTGRES_USER=cab_replay',
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=cab_replay',
    ])
    const redisAddress = await container('valkey/valkey:8-alpine', 6379)
    const databaseUrl = `postgres://cab_replay:${password}@${pgAddress}/cab_replay`
    const redisUrl = `redis://${redisAddress}/0`
    database = postgres(databaseUrl, { connect_timeout: 2 })
    cache = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
    cache.on('error', () => {}) // connect()/commands report readiness failures.
    const readyBy = Date.now() + 30_000
    while (true) {
      try {
        await database`SELECT 1`
        break
      } catch (error) {
        if (Date.now() >= readyBy) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    await cache.connect()
    await exec('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
      env: { ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl },
      maxBuffer: 1024 * 1024,
    })
    // Copy only the suite's real card catalog. This is fixture setup; outcome
    // assertions stay at HTTP/WebSocket and no live rooms are inspected.
    const source = postgres(process.env['DATABASE_URL']!)
    try {
      await source.begin('isolation level repeatable read read only', async (snapshot) => {
        for (const table of ['packs', 'black_cards', 'white_cards']) {
          const rows = await snapshot`SELECT * FROM ${snapshot(table)}`
          if (rows.length) await database!`INSERT INTO ${database!(table)} ${database!(rows)}`
        }
      })
    } finally {
      await source.end({ timeout: 1 })
    }
    return {
      env: { DATABASE_URL: databaseUrl, REDIS_URL: redisUrl },
      async reset() {
        await database!`TRUNCATE game_rounds, game_players, game_sessions RESTART IDENTITY CASCADE`
        await cache!.flushdb()
      },
      close,
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Replay fixture setup and cleanup failed', {
        cause: cleanupError,
      })
    }
    throw new Error(
      'Seeded replay needs a working Docker daemon and postgres:17-alpine / valkey/valkey:8-alpine images; fixture setup failed',
      { cause: error },
    )
  }
}
