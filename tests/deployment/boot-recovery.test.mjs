import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import postgres from 'postgres'
import Redis from 'ioredis'
import { storageProxy } from '../fixtures/storage-proxy.mjs'

const base = 'http://127.0.0.1:3139'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(50)
  }
  throw new Error('Timed out waiting for boot recovery')
}
async function connect(member) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/games/${member.roomCode}/ws`)
  const events = []
  ws.onmessage = (event) => events.push(JSON.parse(String(event.data)))
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'auth', sessionToken: member.sessionToken }))
  const auth = await until(() =>
    events.find((event) => ['auth_ok', 'auth_error'].includes(event.type)),
  )
  assert.equal(auth.type, 'auth_ok', JSON.stringify(auth))
  const heartbeat = setInterval(() => ws.send(JSON.stringify({ type: 'ping' })), 5000)
  return {
    events,
    send(message) {
      ws.send(JSON.stringify(message))
    },
    close() {
      clearInterval(heartbeat)
      ws.close()
    },
    async snapshot() {
      const after = events.length
      ws.send(JSON.stringify({ type: 'rejoin' }))
      const event = await until(() =>
        events.slice(after).find((event) => event.type === 'state_snapshot'),
      )
      return event.state
    },
  }
}

test(
  'unavailable storage and a partial room failure recover without restarting or duplicating work',
  { timeout: 60000 },
  async () => {
    assert.equal(new URL(process.env.DATABASE_URL).pathname, '/cab_audit_issue39')
    assert.equal(new URL(process.env.REDIS_URL).pathname, '/8')
    const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} })
    const observer = new Redis(process.env.REDIS_URL)
    const pg = await storageProxy(process.env.DATABASE_URL, false)
    const cache = await storageProxy(process.env.REDIS_URL, false)
    let child
    let log = ''
    let lastHealth
    const peers = []
    const events = new Map()
    try {
      await assert.rejects(fetch(base + '/api/healthz'), 'Port3139 must be unoccupied')
      await sql`DROP TRIGGER IF EXISTS issue39_outcome_fault ON game_rounds`
      await sql`DROP FUNCTION IF EXISTS issue39_outcome_fault()`
      await sql`TRUNCATE game_rounds, game_matches, game_players, game_sessions RESTART IDENTITY CASCADE`
      await observer.flushdb()
      const [pack] =
        await sql`INSERT INTO packs (id,name,slug,card_count) VALUES ('issue39-pack','Issue39 recovery fixture','issue39-recovery',300) ON CONFLICT (slug) DO UPDATE SET card_count=300 RETURNING id`
      await sql`INSERT INTO black_cards (id,pack_id,text,pick) SELECT 'issue39-black-' || n, ${pack.id}, 'Issue39 prompt ' || n || ': __________.', 1 FROM generate_series(0,79) n ON CONFLICT DO NOTHING`
      await sql`INSERT INTO white_cards (id,pack_id,text) SELECT 'issue39-white-' || n, ${pack.id}, 'Issue39 answer ' || n || '.' FROM generate_series(0,219) n ON CONFLICT DO NOTHING`
      const setup = await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'tests/fixtures/boot-rooms.ts'],
        {
          env: { ...process.env, NODE_ENV: 'test' },
          timeout: 15000,
        },
      )
      const rooms = JSON.parse(setup.stdout.match(/ISSUE39_ROOMS:(.+)/)[1])
      observer.on('message', (channel, raw) =>
        events.get(channel.split(':')[1]).push(JSON.parse(raw)),
      )
      for (const room of rooms) {
        events.set(room.code, [])
        await observer.subscribe(`game:${room.code}:channel`)
      }
      child = spawn(process.execPath, ['--import', 'tsx', 'server.prod.ts'], {
        env: {
          ...process.env,
          DATABASE_URL: pg.url,
          REDIS_URL: cache.url,
          NODE_ENV: 'test',
          PORT: '3139',
          PUBLIC_SITE_URL: base,
          CAB_ROUND_RESULT_PAUSE_MS: '5',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      child.stdout.on('data', (data) => (log += data))
      child.stderr.on('data', (data) => (log += data))
      const health = async () => {
        assert.equal(child.exitCode, null, log)
        try {
          const response = await fetch(base + '/api/healthz', { signal: AbortSignal.timeout(3000) })
          lastHealth = { status: response.status, ...(await response.json()) }
          return lastHealth
        } catch (error) {
          lastHealth = String(error)
          return null
        }
      }
      const waiting = await until(async () => {
        const current = await health()
        return current?.recovery?.stage === 'schema' ? current : null
      })
      assert.equal(waiting.status, 503)
      assert.equal(waiting.db, 'down')
      assert.equal(waiting.recovery.ready, false)
      assert.ok(waiting.recovery.attempts >= 1)
      assert.equal((await fetch(base + '/api/packs')).status, 503)
      pg.setAvailable(true)
      const redisDown = await until(async () => {
        const current = await health()
        return current?.db === 'ok' && current.redis === 'down' ? current : null
      })
      assert.equal(redisDown.status, 503)
      assert.equal(redisDown.recovery.ready, false)
      cache.setAvailable(true)
      const partial = await until(async () => {
        const current = await health()
        return current?.recovery?.attempts >= 3 && current.recovery.rooms?.pending === 1
          ? current
          : null
      })
      assert.equal(partial.db, 'ok')
      assert.equal(partial.redis, 'ok')
      assert.equal(partial.status, 503)
      assert.equal(partial.recovery.ready, false)
      assert.equal(partial.recovery.connectionsReady, true)
      assert.deepEqual(partial.recovery.rooms, { total: 4, recovered: 3, pending: 1 })
      assert.ok(partial.recovery.nextRetryAt > Date.now())
      assert.ok(partial.recovery.nextRetryAt - Date.now() <= 30000)
      // The failing room sorts before these two rooms. They must already have
      // progressed while both stores are healthy but boot recovery is incomplete.
      const roomPeers = new Map()
      for (const room of rooms) {
        const connected = []
        for (const member of room.members) {
          const peer = await connect(member)
          peers.push(peer)
          connected.push(peer)
        }
        roomPeers.set(room.code, connected)
      }
      assert.equal((await roomPeers.get('B39CCC')[0].snapshot()).phase, 'judging')
      assert.equal((await roomPeers.get('B39DDD')[0].snapshot()).round, 2)
      assert.equal(events.get('B39BBB').filter((event) => event.type === 'round_won').length, 0)
      await sql`DROP TRIGGER issue39_outcome_fault ON game_rounds`
      await sql`DROP FUNCTION issue39_outcome_fault()`
      const ready = await until(async () => {
        const current = await health()
        return current?.recovery?.ready ? current : null
      })
      assert.equal(ready.status, 200)
      assert.equal(ready.recovery.stage, 'ready')
      assert.equal(ready.recovery.nextRetryAt, null)
      assert.deepEqual(ready.recovery.rooms, { total: 4, recovered: 4, pending: 0 })
      await until(() =>
        events.get('B39AAA').some((event) => event.type === 'round_started' && event.round === 2),
      )
      for (const code of ['B39AAA', 'B39DDD']) {
        assert.equal(
          events.get(code).filter((event) => event.type === 'player_skipped' && event.round === 1)
            .length,
          2,
        )
        assert.equal(
          events.get(code).filter((event) => event.type === 'round_started' && event.round === 2)
            .length,
          1,
        )
      }
      const recovered = events.get('B39BBB')
      assert.equal(recovered.filter((event) => event.type === 'round_won').length, 1)
      assert.equal(recovered.filter((event) => event.type === 'round_end').length, 1)
      assert.equal(
        recovered.filter((event) => event.type === 'round_started' && event.round === 2).length,
        1,
      )
      // Use each recovered room's real WS commands to complete its next round.
      for (const room of rooms) {
        const clients = roomPeers.get(room.code)
        const current = await clients[0].snapshot()
        if (room.code !== 'B39CCC') {
          for (let index = 0; index < clients.length; index++) {
            if (room.members[index].playerId === current.czarId) continue
            const hand = (await clients[index].snapshot()).hand
            assert.equal(new Set(hand.map((card) => card.id)).size, 10)
            clients[index].send({
              type: 'play',
              cardIds: hand.slice(0, current.prompt.pick).map((card) => card.id),
            })
          }
          await until(() => events.get(room.code).some((event) => event.type === 'reveal_start'))
          await sleep(1600)
        }
        const judge =
          clients[room.members.findIndex((member) => member.playerId === current.czarId)]
        const nextRound = current.round + 1
        judge.send({ type: 'pick', submissionId: '0' })
        await until(() =>
          events
            .get(room.code)
            .some((event) => event.type === 'round_started' && event.round === nextRound),
        )
      }
      assert.equal(child.exitCode, null)
    } catch (error) {
      throw new Error(
        `${error.message}\nLast health: ${JSON.stringify(lastHealth)}\n${log.slice(-30000)}`,
        { cause: error },
      )
    } finally {
      for (const peer of peers) peer.close()
      if (child && child.exitCode === null) {
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      }
      await observer.quit()
      await pg.close()
      await cache.close()
      await sql`DROP TRIGGER IF EXISTS issue39_outcome_fault ON game_rounds`
      await sql`DROP FUNCTION IF EXISTS issue39_outcome_fault()`
      await sql`TRUNCATE game_rounds, game_matches, game_players, game_sessions RESTART IDENTITY CASCADE`
      await sql.end()
      const cleanup = new Redis(process.env.REDIS_URL)
      await cleanup.flushdb()
      await cleanup.quit()
    }
  },
)

test(
  'schema policy and configuration failures still refuse startup before jobs or traffic',
  { timeout: 30000 },
  async () => {
    assert.equal(new URL(process.env.DATABASE_URL).pathname, '/cab_audit_issue39')
    assert.equal(new URL(process.env.REDIS_URL).pathname, '/8')
    const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} })
    const temporary = await mkdtemp(join(tmpdir(), 'cab-issue39-schema-'))
    async function refuses(expected, env = {}, cwd = process.cwd()) {
      const child = spawn(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), resolve('server.prod.ts')],
        {
          cwd,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: '3139',
            PUBLIC_SITE_URL: base,
            ...env,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let log = ''
      child.stdout.on('data', (data) => (log += data))
      child.stderr.on('data', (data) => (log += data))
      try {
        await until(() => child.exitCode !== null, 8000)
        assert.equal(child.exitCode, 1, log)
        assert.match(log, expected)
        assert.doesNotMatch(log, /Listening on|starting REST AH seed|retrying in/)
      } finally {
        if (child.exitCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
      }
    }
    try {
      await sql`ALTER TABLE packs ADD COLUMN issue39_drift text`
      await refuses(/schema drift/)
      await sql`ALTER TABLE packs DROP COLUMN issue39_drift`
      await sql`ALTER TABLE cab_migrations.history RENAME TO issue39_history`
      await refuses(/Unversioned database/)
      await sql`ALTER TABLE cab_migrations.issue39_history RENAME TO history`
      const [history] =
        await sql`SELECT position, sha256 FROM cab_migrations.history ORDER BY position LIMIT 1`
      await sql`UPDATE cab_migrations.history SET sha256='issue39-corrupt' WHERE position=${history.position}`
      await refuses(/Incompatible migration history/)
      await sql`UPDATE cab_migrations.history SET sha256=${history.sha256} WHERE position=${history.position}`
      const badPassword = new URL(process.env.DATABASE_URL)
      badPassword.password = 'issue39-invalid-password'
      await refuses(/password authentication failed/, {
        DATABASE_URL: badPassword.toString(),
      })
      await cp('drizzle', join(temporary, 'drizzle'), { recursive: true })
      const manifest = JSON.parse(await readFile(join(temporary, 'drizzle/manifest.json'), 'utf8'))
      const pending = '-- issue39 pending reviewed migration\n'
      await writeFile(join(temporary, 'drizzle/9999_issue39.sql'), pending)
      await writeFile(
        join(temporary, 'drizzle/manifest.json'),
        JSON.stringify([
          ...manifest,
          {
            file: '9999_issue39.sql',
            sha256: createHash('sha256').update(pending).digest('hex'),
            schema: manifest.at(-1).schema,
          },
        ]),
      )
      await refuses(/Pending migrations/, {}, temporary)
      await writeFile(join(temporary, 'drizzle/manifest.json'), JSON.stringify(manifest))
      await writeFile(join(temporary, 'drizzle', manifest[0].file), '-- checksum tampered\n')
      await refuses(/Migration checksum mismatch/, {}, temporary)
    } finally {
      await sql`ALTER TABLE packs DROP COLUMN IF EXISTS issue39_drift`
      const [renamed] = await sql`SELECT to_regclass('cab_migrations.issue39_history') AS present`
      if (renamed.present) await sql`ALTER TABLE cab_migrations.issue39_history RENAME TO history`
      const manifest = JSON.parse(await readFile('drizzle/manifest.json', 'utf8'))
      for (const [position, migration] of manifest.entries())
        await sql`UPDATE cab_migrations.history SET sha256=${migration.sha256} WHERE position=${position}`
      await sql.end()
      await rm(temporary, { recursive: true, force: true })
    }
  },
)
