import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import postgres from 'postgres'
import Redis from 'ioredis'
import { storageProxy } from '../fixtures/storage-proxy.mjs'

// Caller owns these disposable stores. Never signal or reset an existing app.
const base = 'http://127.0.0.1:3154'
const contenderBase = 'http://127.0.0.1:3155'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await sleep(50)
  }
  throw new Error('Timed out waiting for runtime ownership behavior')
}
function start(url = base, env = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.prod.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: new URL(url).port,
      PUBLIC_SITE_URL: url,
      CAB_ROUND_RESULT_PAUSE_MS: '5',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let stderr = ''
  child.stdout.on('data', (data) => (output += data))
  child.stderr.on('data', (data) => {
    output += data
    stderr += data
  })
  return {
    child,
    get output() {
      return output
    },
    get stderr() {
      return stderr
    },
    async ready() {
      await until(async () => {
        assert.equal(child.exitCode, null, output)
        return fetch(url + '/api/healthz').then(
          (response) => response.ok,
          () => false,
        )
      })
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    },
  }
}

function ownershipFailure(app) {
  const records = app.stderr.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  const record = records.find((entry) => entry.msg?.includes('Runtime ownership lost; exiting'))
  assert.ok(record, `Expected structured ownership failure on stderr:\n${app.stderr}`)
  assert.equal(record.level, 60)
  assert.equal(record.mod, 'cab.runtime')
  return record
}
async function post(path, body, token) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
  return response.json().catch(() => ({}))
}
async function connect(member) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/games/${member.roomCode}/ws`)
  const events = []
  ws.onmessage = (event) => events.push(JSON.parse(String(event.data)))
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'auth', sessionToken: member.sessionToken }))
  assert.equal(
    (await until(() => events.find((event) => ['auth_ok', 'auth_error'].includes(event.type))))
      .type,
    'auth_ok',
  )
  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
  }, 5000)
  return {
    events,
    close() {
      clearInterval(heartbeat)
      ws.close()
    },
    async snapshot() {
      const after = events.length
      ws.send(JSON.stringify({ type: 'rejoin' }))
      const event = await until(() =>
        events
          .slice(after)
          .find((event) => ['state_snapshot', 'lobby_snapshot'].includes(event.type)),
      )
      return event.state ?? event
    },
  }
}

test(
  'a competing runtime is refused before it can duplicate round timers or disconnect effects',
  { timeout: 60000 },
  async () => {
    assert.equal(new URL(process.env.DATABASE_URL).pathname, '/cab_audit_issue54')
    assert.equal(new URL(process.env.REDIS_URL).pathname, '/9')
    const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} })
    const cache = new Redis(process.env.REDIS_URL)
    const processes = []
    const peers = []
    try {
      await assert.rejects(fetch(base + '/api/healthz'), 'Port 3154 must be unoccupied')
      await assert.rejects(fetch(contenderBase + '/api/healthz'), 'Port 3155 must be unoccupied')
      await sql`TRUNCATE game_rounds, game_matches, game_players, game_sessions RESTART IDENTITY CASCADE`
      await cache.flushdb()
      const [pack] =
        await sql`INSERT INTO packs (id,name,slug,card_count) VALUES ('issue54-pack','Issue54 ownership fixture','issue54-ownership',300) ON CONFLICT (slug) DO UPDATE SET card_count=300 RETURNING id`
      await sql`INSERT INTO black_cards (id,pack_id,text,pick) SELECT 'issue54-black-' || n, ${pack.id}, 'Issue54 prompt ' || n || ': __________.', 1 FROM generate_series(0,79) n ON CONFLICT DO NOTHING`
      await sql`INSERT INTO white_cards (id,pack_id,text) SELECT 'issue54-white-' || n, ${pack.id}, 'Issue54 answer ' || n || '.' FROM generate_series(0,219) n ON CONFLICT DO NOTHING`
      const owner = start()
      processes.push(owner)
      await owner.ready()
      async function room(name, timer) {
        const host = await post('/api/games', {
          username: name + 'Host',
          anonId: name + '-host',
          config: { maxPlayers: 3, roundsToWin: 20, timer, packs: [pack.id], rules: [] },
        })
        const members = [host]
        for (const suffix of ['Second', 'Third']) {
          members.push({
            ...(await post(`/api/games/${host.roomCode}/join`, {
              username: name + suffix,
              anonId: name + suffix,
              role: 'player',
            })),
            roomCode: host.roomCode,
          })
        }
        const clients = []
        for (const member of members) {
          const peer = await connect(member)
          clients.push(peer)
          peers.push(peer)
        }
        return { host, members, clients }
      }
      const timed = await room('Timed', '30s')
      await post(`/api/games/${timed.host.roomCode}/start`, {}, timed.host.sessionToken)
      const leaving = await room('Leaving', 'Off')
      leaving.clients[0].close()
      const contender = start(contenderBase)
      processes.push(contender)
      await until(() => contender.child.exitCode !== null, 5000)
      assert.equal(contender.child.exitCode, 1, contender.output)
      assert.match(
        contender.output,
        /runtime ownership.*another app|another app.*runtime ownership/i,
      )
      assert.doesNotMatch(contender.output, /Listening on|starting REST AH seed/)
      await assert.rejects(fetch(contenderBase + '/api/healthz'))
      await until(
        () =>
          timed.clients[0].events.some(
            (event) => event.type === 'round_started' && event.round === 2,
          ) && leaving.clients[1].events.some((event) => event.type === 'host_changed'),
        35000,
      ).catch((error) => {
        throw new Error(
          `${error.message}\nTimer events: ${JSON.stringify(timed.clients[0].events)}\nDisconnect events: ${JSON.stringify(leaving.clients[1].events)}\n${owner.output}`,
          { cause: error },
        )
      })
      const roundEvents = timed.clients[0].events
      assert.equal(
        roundEvents.filter((event) => event.type === 'player_skipped' && event.round === 1).length,
        2,
      )
      assert.equal(
        roundEvents.filter((event) => event.type === 'round_started' && event.round === 2).length,
        1,
      )
      const disconnectEvents = leaving.clients[1].events
      assert.equal(
        disconnectEvents.filter(
          (event) => event.type === 'player_left' && event.playerId === leaving.host.playerId,
        ).length,
        1,
      )
      assert.equal(disconnectEvents.filter((event) => event.type === 'host_changed').length, 1)
      assert.equal((await timed.clients[0].snapshot()).round, 2)
      assert.equal(
        (await leaving.clients[1].snapshot()).players.find((player) => player.isHost)?.id,
        leaving.members[1].playerId,
      )
      // Abrupt death releases the session lock; no operator stale-unlock step.
      for (const peer of peers) peer.close()
      await owner.stop()
      const replacement = start()
      processes.push(replacement)
      await replacement.ready()
    } finally {
      for (const peer of peers) peer.close()
      for (const app of processes) await app.stop()
      cache.disconnect()
      await sql.end({ timeout: 1 })
    }
  },
)

test(
  'loss of the ownership session stops the runtime and permits supervisor recovery',
  { timeout: 20000 },
  async (t) => {
    assert.equal(new URL(process.env.DATABASE_URL).pathname, '/cab_audit_issue54')
    assert.equal(new URL(process.env.REDIS_URL).pathname, '/9')
    const sql = postgres(process.env.DATABASE_URL)
    const processes = []
    try {
      await assert.rejects(fetch(base + '/api/healthz'), 'Port 3154 must be unoccupied')
      const owner = start()
      processes.push(owner)
      await owner.ready()
      const terminated =
        await sql`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname=current_database() AND application_name='cab-runtime-owner'`
      assert.equal(terminated.length, 1)
      assert.equal(terminated[0].terminated, true)
      await until(() => owner.child.exitCode !== null, 5000)
      assert.equal(owner.child.exitCode, 1, owner.output)
      const failure = ownershipFailure(owner)
      assert.match(failure.reason, /ownership session closed|terminating connection/)
      t.diagnostic(`Captured stderr: ${JSON.stringify(failure)}`)
      await assert.rejects(fetch(base + '/api/healthz'))
      const replacement = start()
      processes.push(replacement)
      await replacement.ready()
    } finally {
      for (const app of processes) await app.stop()
      await sql.end({ timeout: 1 })
    }
  },
)

test(
  'an unresponsive ownership connection stops the runtime within a bounded deadline',
  { timeout: 25000 },
  async (t) => {
    assert.equal(new URL(process.env.DATABASE_URL).pathname, '/cab_audit_issue54')
    assert.equal(new URL(process.env.REDIS_URL).pathname, '/9')
    const pg = await storageProxy(process.env.DATABASE_URL)
    const processes = []
    try {
      await assert.rejects(fetch(base + '/api/healthz'), 'Port 3154 must be unoccupied')
      const owner = start(base, { DATABASE_URL: pg.url })
      processes.push(owner)
      await owner.ready()
      pg.setResponsive(false)
      await until(() => owner.child.exitCode !== null, 8000)
      assert.equal(owner.child.exitCode, 1, owner.output)
      const failure = ownershipFailure(owner)
      assert.equal(failure.reason, 'PostgreSQL ownership probe timed out')
      t.diagnostic(`Captured stderr: ${JSON.stringify(failure)}`)
      await assert.rejects(fetch(base + '/api/healthz'))
      pg.setAvailable(false)
      const replacement = start()
      processes.push(replacement)
      await replacement.ready()
    } finally {
      for (const app of processes) await app.stop()
      await pg.close()
    }
  },
)
