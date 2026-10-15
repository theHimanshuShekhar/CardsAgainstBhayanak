import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

// Own the application process; never signal an existing server. The caller
// supplies isolated, migrated and seeded PostgreSQL/Redis databases.
const base = 'http://127.0.0.1:3137'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await check()
    if (value) return value
    await sleep(50)
  }
  throw new Error('Timed out waiting for restart behavior')
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
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  await once(ws, 'open')
  ws.send(JSON.stringify({ type: 'auth', sessionToken: member.sessionToken }))
  const auth = await until(() =>
    events.find((event) => ['auth_ok', 'auth_error'].includes(event.type)),
  )
  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }))
  }, 5000)
  return {
    ws,
    events,
    auth,
    close() {
      clearInterval(ping)
      ws.close()
    },
    async snapshot() {
      const after = events.length
      ws.send(JSON.stringify({ type: 'rejoin' }))
      return until(() =>
        events
          .slice(after)
          .find((event) => event.type === 'state_snapshot' || event.type === 'lobby_snapshot'),
      )
    },
  }
}

test(
  'owned process restarts restore grace and abrupt-death deadlines through HTTP and WS',
  { timeout: 150000 },
  async () => {
    assert.ok(
      process.env.DATABASE_URL?.endsWith('/cab_audit_issue37'),
      'Dedicated issue37 database required',
    )
    assert.ok(process.env.REDIS_URL?.endsWith('/11'), 'Dedicated issue37 Redis DB required')
    let child
    let log = ''
    const peers = []
    async function start() {
      // A listener already present is never ours to replace.
      try {
        await fetch(base + '/api/healthz')
        assert.fail('Port3137 already occupied')
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error
      }
      child = spawn(process.execPath, ['--import', 'tsx', 'server.prod.ts'], {
        env: { ...process.env, NODE_ENV: 'test', PORT: '3137', PUBLIC_SITE_URL: base },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout.on('data', (data) => {
        log += data
      })
      child.stderr.on('data', (data) => {
        log += data
      })
      try {
        await until(async () => {
          try {
            return (await fetch(base + '/api/healthz')).ok
          } catch {
            return false
          }
        }, 15000)
      } catch (error) {
        throw new Error(log, { cause: error })
      }
    }
    async function kill() {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
      child = undefined
    }
    async function socket(member) {
      const peer = await connect(member)
      peers.push(peer)
      return peer
    }
    async function room(name) {
      const { packs } = await (await fetch(base + '/api/packs')).json()
      const config = {
        maxPlayers: 4,
        roundsToWin: 20,
        timer: 'Off',
        packs: [packs.find((pack) => /base/i.test(pack.name)).id],
        rules: [],
      }
      const host = await post('/api/games', {
        username: name + 'Host',
        anonId: name + '-host',
        config,
      })
      const join = async (username) => ({
        ...(await post(`/api/games/${host.roomCode}/join`, {
          username,
          anonId: username,
          role: 'player',
        })),
        roomCode: host.roomCode,
      })
      return { host, second: await join(name + 'Second'), third: await join(name + 'Third'), join }
    }
    try {
      await start()
      const reconnecting = await room('Returning')
      const returningHost = await socket(reconnecting.host)
      const clean = await room('Clean')
      const host = await socket(clean.host)
      await post(`/api/games/${clean.host.roomCode}/start`, {}, clean.host.sessionToken)
      const queued = await clean.join('CleanQueued')
      const queuedPeer = await socket(queued)
      const second = await socket(clean.second)
      const third = await socket(clean.third)
      host.close()
      returningHost.close()
      await sleep(500)
      await kill()
      await start()
      const returned = await socket(reconnecting.host)
      assert.equal(returned.auth.type, 'auth_ok')
      const observer = await socket(clean.second)
      const survivor = await socket(clean.third)
      const returningQueued = await socket(queued)
      assert.equal(returningQueued.auth.type, 'auth_ok')
      const restored = (await returningQueued.snapshot()).state
      assert.equal(restored.hand, undefined)
      returningQueued.ws.send(JSON.stringify({ type: 'play', cardIds: ['not-in-hand'] }))
      assert.equal(
        (await until(() => returningQueued.events.find((event) => event.type === 'error'))).code,
        'not_authorized',
      )
      assert.equal(observer.events.filter((event) => event.type === 'player_left').length, 0)
      await until(
        () =>
          observer.events.find(
            (event) => event.type === 'player_left' && event.playerId === clean.host.playerId,
          ),
        33000,
      )
      assert.equal(
        observer.events.filter(
          (event) => event.type === 'player_left' && event.playerId === clean.host.playerId,
        ).length,
        1,
      )
      await until(() =>
        observer.events.find(
          (event) => event.type === 'host_changed' && event.hostId === clean.second.playerId,
        ),
      )
      const snapshot = await until(async () => {
        const current = (await observer.snapshot()).state
        return current.hostId === clean.second.playerId && current.expected === 1 ? current : null
      })
      assert.equal(snapshot.hostId, clean.second.playerId)
      assert.equal(snapshot.expected, 1)
      assert.equal((await returningQueued.snapshot()).state.hand, undefined)
      assert.equal(
        (await returned.snapshot()).players.find(
          (player) => player.id === reconnecting.host.playerId,
        ).status,
        'active',
      )
      assert.equal(
        returned.events.filter(
          (event) => event.type === 'player_left' && event.playerId === reconnecting.host.playerId,
        ).length,
        0,
      )
      const rejected = await socket(clean.host)
      assert.equal(rejected.auth.code, 'player_dropped')
      for (const peer of [queuedPeer, second, third, observer, survivor, returningQueued, rejected])
        peer.close()

      const abrupt = await room('Abrupt')
      await socket(abrupt.host)
      // No close callback can run in a SIGKILLed process. Also kill the
      // replacement after boot while ownership is still valid.
      await kill()
      await start()
      const live = await socket(abrupt.second)
      const before = await live.snapshot()
      assert.equal(
        before.players.find((player) => player.id === abrupt.host.playerId).status,
        'active',
      )
      live.close()
      await kill()
      await sleep(76000)
      await start()
      const gone = await socket(abrupt.host)
      assert.equal(gone.auth.code, 'player_dropped')
      const remaining = await socket(abrupt.third)
      assert.equal(remaining.auth.type, 'auth_ok')
      const after = await remaining.snapshot()
      assert.ok(after.players.some((player) => player.isHost && player.id !== abrupt.host.playerId))
    } finally {
      for (const peer of peers) peer.close()
      if (child) await kill()
    }
  },
)
