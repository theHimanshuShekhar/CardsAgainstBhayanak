import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect } from '@playwright/test'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import type { ClientToServerEvent, ServerToClientEvent } from '../../src/lib/types'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'
type Member = { roomCode: string; playerId: string; sessionToken: string }

const connections = new Map<WebSocket, ReturnType<typeof setInterval> | undefined>()
test.afterEach(async () => {
  // Also closes peers from a fixture whose create/join/auth step failed.
  for (const [socket, heartbeat] of connections) {
    clearInterval(heartbeat)
    socket.close()
  }
  connections.clear()
})

async function post(path: string, body: unknown, token?: string) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
}

async function connect(member: Member) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/games/${member.roomCode}/ws`)
  connections.set(ws, undefined)
  ws.addEventListener(
    'close',
    () => {
      clearInterval(connections.get(ws))
      connections.delete(ws)
    },
    { once: true },
  )
  const events: ServerToClientEvent[] = []
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      ws.close()
      reject(new Error(`WebSocket open timed out for ${member.roomCode}`))
    }, 10_000)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(deadline)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(deadline)
        reject(new Error(`WebSocket connection failed for ${member.roomCode}`))
      },
      { once: true },
    )
  })
  const peer = {
    ...member,
    ws,
    events,
    send(event: ClientToServerEvent) {
      ws.send(JSON.stringify(event))
    },
    async wait<T extends ServerToClientEvent['type']>(type: T, after = 0) {
      await expect
        .poll(
          () => {
            if (ws.readyState === WebSocket.CLOSED)
              throw new Error(
                `Socket closed before ${type}; last events: ${events
                  .slice(-5)
                  .map((event) => event.type)
                  .join(', ')}`,
              )
            return events.slice(after).find((event) => event.type === type)
          },
          { timeout: 30_000, message: `Waiting for ${type} in ${member.roomCode}` },
        )
        .toBeTruthy()
      return events.slice(after).find((event) => event.type === type) as Extract<
        ServerToClientEvent,
        { type: T }
      >
    },
    async snapshot() {
      return requestStateSnapshot(ws, events)
    },
  }
  peer.send({ type: 'auth', sessionToken: member.sessionToken })
  await peer.wait('auth_ok')
  connections.set(
    ws,
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) peer.send({ type: 'ping' })
    }, 15_000),
  )
  return peer
}

// Catalog setup is the only database access: gameplay and result assertions
// use HTTP, WebSocket and the real browser, never live storage internals.
test('two black cards end with the earliest seated tied leader and identical client results', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const catalog = postgres(process.env['DATABASE_URL']!)
  const packId = randomUUID()
  try {
    await catalog`INSERT INTO packs (id, name, slug, card_count) VALUES (${packId}, 'Exhaustion fixture', ${packId}, 62)`
    for (let i = 0; i < 2; i++)
      await catalog`INSERT INTO black_cards (id, pack_id, text, pick) VALUES (${randomUUID()}, ${packId}, ${`Exhaustion prompt ${i}: __________`}, 1)`
    for (let i = 0; i < 60; i++)
      await catalog`INSERT INTO white_cards (id, pack_id, text) VALUES (${randomUUID()}, ${packId}, ${`Exhaustion response ${i}`})`
  } finally {
    await catalog.end()
  }
  const created = await post('/api/games', {
    username: 'ExhaustHost',
    anonId: 'exhaust-host',
    config: { maxPlayers: 3, roundsToWin: 20, timer: 'Off', packs: [packId], rules: ['godmode'] },
  })
  expect(created.status).toBe(201)
  const host = (await created.json()) as Member
  const peers = [await connect(host)]
  for (let i = 1; i < 3; i++) {
    const joined = await post(`/api/games/${host.roomCode}/join`, {
      username: `ExhaustPlayer${i}`,
      anonId: `exhaust-${i}`,
      role: 'player',
    })
    expect(joined.status).toBe(200)
    peers.push(await connect({ ...(await joined.json()), roomCode: host.roomCode }))
  }
  await page.goto('/')
  await page.evaluate(
    (member) =>
      localStorage.setItem(
        'cab_session',
        JSON.stringify({
          ...member,
          username: 'ExhaustHost',
          role: 'player',
          anonId: 'exhaust-host',
        }),
      ),
    host,
  )
  await page.goto(`/games/${host.roomCode}/lobby`)
  await expect(page.getByRole('button', { name: /Start game/i })).toBeVisible()
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  for (let round = 1; round <= 2; round++) {
    await expect.poll(async () => (await peers[0]!.snapshot()).round).toBe(round)
    const initial = await Promise.all(peers.map((peer) => peer.snapshot()))
    for (const [i, peer] of peers.entries()) {
      const marker = peer.events.length
      peer.send({
        type: 'play',
        commandId: `exhaust-${round}-${i}`,
        cardIds: [initial[i]!.hand![0]!.id],
      })
      await peer.wait('command_accepted', marker)
    }
    await expect.poll(async () => (await peers[0]!.snapshot()).phase).toBe('waiting')
    const submissions = (await peers[0]!.snapshot()).submissions
    const owned = initial.map(
      (snapshot) =>
        submissions.find((submission) => submission.fills[0]!.id === snapshot.hand![0]!.id)!
          .submissionId,
    )
    const target = round - 1
    const marker = peers[0]!.events.length
    for (const [i, peer] of peers.entries()) {
      const receipt = peer.events.length
      peer.send({ type: 'vote', submissionId: owned[i === target ? (target + 1) % 3 : target]! })
      await peer.wait('vote_tally', receipt)
    }
    expect(await peers[0]!.wait('round_won', marker)).toMatchObject({
      winnerId: peers[target]!.playerId,
    })
    await peers[0]!.wait('round_end', marker)
  }
  const outcomes = await Promise.all(peers.map((peer) => peer.wait('game_over')))
  expect(outcomes[0]).toMatchObject({ winnerId: host.playerId, mode: 'deck_exhausted' })
  for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0])
  expect(
    outcomes[0]!.finalScores.map((score) => ({ username: score.username, score: score.score })),
  ).toEqual([
    { username: 'ExhaustHost', score: 1 },
    { username: 'ExhaustPlayer1', score: 1 },
    { username: 'ExhaustPlayer2', score: 0 },
  ])
  await expect(page).toHaveURL(new RegExp(`/games/${host.roomCode}/end$`))
  await expect(page.getByRole('heading', { name: 'ExhaustHost wins' })).toBeVisible()
  await expect(page.getByText('Decided over 2 rounds.')).toBeVisible()
  for (const [username, score] of [
    ['ExhaustHost', '1 pt'],
    ['ExhaustPlayer1', '1 pt'],
    ['ExhaustPlayer2', '0 pts'],
  ]) {
    await expect(
      page.locator('.score-chip').filter({ hasText: username! }).locator('.score-meta'),
    ).toHaveText(score!)
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: 'ExhaustHost wins' })).toBeVisible()
})
