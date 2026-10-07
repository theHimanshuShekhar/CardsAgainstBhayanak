import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { replayInfrastructure } from '../fixtures/replay-infrastructure'
import type { ClientToServerEvent, ServerToClientEvent } from '../../src/lib/types'

// Own a production-entry subprocess so each replay starts from the same seed.
// Its backing stores belong exclusively to this test, including boot recovery.
const port = Number(process.env['PORT'] ?? 3000) + 100
const base = `http://127.0.0.1:${port}`
type Member = { roomCode: string; playerId: string; sessionToken: string }

async function post(path: string, body: unknown, token?: string) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function connect(member: Member) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/games/${member.roomCode}/ws`)
  const events: ServerToClientEvent[] = []
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    })
  })
  const send = (event: ClientToServerEvent) => ws.send(JSON.stringify(event))
  async function wait<T extends ServerToClientEvent['type']>(type: T, after = 0) {
    await expect.poll(() => events.slice(after).some((event) => event.type === type)).toBe(true)
    return events.slice(after).find((event) => event.type === type) as Extract<
      ServerToClientEvent,
      { type: T }
    >
  }
  send({ type: 'auth', sessionToken: member.sessionToken })
  await wait('auth_ok')
  return {
    ...member,
    ws,
    events,
    send,
    wait,
    async snapshot() {
      const marker = events.length
      send({ type: 'rejoin' })
      return (await wait('state_snapshot', marker)).state
    },
  }
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 3000)
  try {
    await exited
  } finally {
    clearTimeout(force)
  }
}

async function replay(noiseBeforeGame: boolean, env: { DATABASE_URL: string; REDIS_URL: string }) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      resolve('tests/fixtures/fixed-randomness.mjs'),
      'server.prod.ts',
    ],
    {
      env: {
        ...process.env,
        ...env,
        PORT: String(port),
        NODE_ENV: 'production',
        CAB_RNG_SEED: 'final-ballot-replay',
        CAB_ROUND_RESULT_PAUSE_MS: '150',
        CAB_TEST_NOW: noiseBeforeGame ? '1791203600001' : '1791200000000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout!.on('data', (data) => (output += String(data)))
  child.stderr!.on('data', (data) => (output += String(data)))
  const peers: Awaited<ReturnType<typeof connect>>[] = []
  try {
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(output)
          return fetch(base + '/api/healthz').then(
            (response) => response.ok,
            () => false,
          )
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    const { packs } = await (await fetch(base + '/api/packs')).json()
    const pack =
      packs.find((candidate: { name: string }) => /base/i.test(candidate.name)) ?? packs[0]
    const create = () =>
      post('/api/games', {
        username: 'ReplayHost',
        anonId: 'seeded-replay',
        config: {
          maxPlayers: 3,
          roundsToWin: 20,
          timer: 'Off',
          packs: [pack.id],
          rules: ['godmode'],
        },
      })
    async function noise() {
      // Ambient time/random are fixed in this child. Every request must still
      // occupy its own rate-limit entry, without consuming the game PRNG.
      for (let i = 0; i < 4; i++) expect((await create()).status).toBe(201)
    }
    if (noiseBeforeGame) await noise()
    const response = await create()
    expect(response.status).toBe(201)
    const host = (await response.json()) as Member
    peers.push(await connect(host))
    for (let i = 1; i < 3; i++) {
      const joined = await post(`/api/games/${host.roomCode}/join`, {
        username: `ReplayPlayer${i}`,
        anonId: `replay-${i}`,
        role: 'player',
      })
      expect(joined.status).toBe(200)
      peers.push(await connect({ ...(await joined.json()), roomCode: host.roomCode }))
    }
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    await peers[0]!.wait('round_started')
    const initial = await Promise.all(peers.map((peer) => peer.snapshot()))
    for (const [i, peer] of peers.entries()) {
      const snapshot = initial[i]!
      const receiptMarker = peer.events.length
      peer.send({
        type: 'play',
        commandId: `replay-play-${i}`,
        cardIds: snapshot.hand!.slice(0, snapshot.prompt.pick).map((card) => card.id),
      })
      await peer.wait('command_accepted', receiptMarker)
    }
    await expect.poll(async () => (await peers[0]!.snapshot()).phase).toBe('waiting')
    const submissions = (await peers[0]!.snapshot()).submissions
    const owned = initial.map(
      (snapshot) =>
        submissions.find((submission) =>
          snapshot.hand!.some((card) => card.id === submission.fills[0]!.id),
        )!.submissionId,
    )
    for (let ballot = 0; ballot < 3; ballot++) {
      const marker = peers[0]!.events.length
      for (const [i, peer] of peers.entries()) {
        // A cycle gives every candidate one vote, with no self-votes.
        const receiptMarker = peer.events.length
        peer.send({ type: 'vote', submissionId: owned[(i + 1) % 3]! })
        await peer.wait('vote_tally', receiptMarker)
      }
      if (ballot < 2) {
        await expect
          .poll(() =>
            peers[0]!.events
              .slice(marker)
              .some(
                (event) => event.type === 'vote_tally' && Object.keys(event.votes).length === 0,
              ),
          )
          .toBe(true)
      } else await peers[0]!.wait('round_won', marker)
    }
    const outcome = peers[0]!.events.find((event) => event.type === 'round_won')!
    const winnerOrdinal = peers.findIndex((peer) => peer.playerId === outcome.winnerId)
    expect(winnerOrdinal).toBeGreaterThanOrEqual(0)
    await peers[0]!.wait('round_end')
    if (!noiseBeforeGame) await noise()
    expect((await create()).status).toBe(429)
    return {
      winnerOrdinal,
      winnerSubmissionId: outcome.submissionId,
      hands: initial.map((state) => state.hand),
    }
  } catch (error) {
    throw new Error(`${String(error)}\nChild output:\n${output}`, { cause: error })
  } finally {
    peers.forEach((peer) => peer.ws.close())
    await stop(child)
  }
}

test('seeded tied ballots repeat the winner despite distinct same-millisecond rate-limit traffic', async () => {
  test.setTimeout(180_000)
  const infrastructure = await replayInfrastructure()
  let replayFailure: { error: unknown } | undefined
  try {
    const first = await replay(false, infrastructure.env)
    await infrastructure.reset()
    const second = await replay(true, infrastructure.env)
    expect(second).toEqual(first)
    console.info('Seeded replays matched hands and winner; rate-limit entries remained distinct')
  } catch (error) {
    replayFailure = { error }
  }
  try {
    await infrastructure.close()
  } catch (cleanupError) {
    if (replayFailure) {
      throw new AggregateError(
        [replayFailure.error, cleanupError],
        'Replay and fixture cleanup both failed',
        { cause: cleanupError },
      )
    }
    throw cleanupError
  }
  if (replayFailure) throw replayFailure.error
})
