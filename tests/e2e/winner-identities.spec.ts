import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect } from '@playwright/test'
import type { ClientToServerEvent, ServerToClientEvent, RuleId } from '../../src/lib/types'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'
type Member = { roomCode: string; playerId: string; sessionToken: string }

const connections = new Map<WebSocket, ReturnType<typeof setInterval> | undefined>()
const requestTimings: { method: string; path: string; responseHeadersMs: number }[] = []

test.beforeEach(() => {
  requestTimings.length = 0
})
test.afterEach(async () => {
  // Also closes peers from a fixture whose create/join/auth step failed.
  for (const [socket, heartbeat] of connections) {
    clearInterval(heartbeat)
    socket.close()
  }
  connections.clear()
  await test.info().attach('winner-request-timings', {
    body: JSON.stringify(requestTimings),
    contentType: 'application/json',
  })
})

async function request(method: string, path: string, body?: unknown, token?: string) {
  const started = Date.now()
  try {
    return await test.step(`${method} ${path}`, () =>
      fetch(BASE + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // Keep stalled setup visible as a request failure rather than an opaque
        // whole-test timeout. The deadline also covers reading the response body.
        signal: AbortSignal.timeout(10_000),
      }))
  } finally {
    requestTimings.push({ method, path, responseHeadersMs: Date.now() - started })
  }
}

async function post(path: string, body: unknown, token?: string) {
  return request('POST', path, body, token)
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
type Peer = Awaited<ReturnType<typeof connect>>

async function join(roomCode: string, username: string, role = 'player'): Promise<Member> {
  const response = await post(`/api/games/${roomCode}/join`, {
    username,
    anonId: `resolution-${username}`,
    role,
  })
  expect(response.status).toBe(200)
  return { ...(await response.json()), roomCode }
}

async function start(rules: RuleId[] = [], roundsToWin = 20, begin = true, playerCount = 4) {
  const { packs } = (await (await request('GET', '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'ResolutionHost',
    anonId: 'resolution-host',
    config: { maxPlayers: 10, roundsToWin, timer: 'Off', packs: [pack.id], rules },
  })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const members = [host]
  for (let i = 1; i < playerCount; i++) members.push(await join(host.roomCode, `Player${i}`))
  const peers = await Promise.all(members.map(connect))
  let czar: Peer | undefined
  if (begin) {
    expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
      204,
    )
    await peers[0]!.wait('round_started')
    const initial = await peers[0]!.snapshot()
    czar = peers.find((peer) => peer.playerId === initial.czarId)
  }
  return { host, peers, czar, close: () => peers.forEach((peer) => peer.ws.close()) }
}

async function ready(game: Awaited<ReturnType<typeof start>>) {
  for (const peer of game.peers) {
    if (peer === game.czar) continue
    const snapshot = await peer.snapshot()
    peer.send({
      type: 'play',
      cardIds: snapshot.hand!.slice(0, snapshot.prompt.pick).map((card) => card.id),
      commandId: `play-${snapshot.round}-${peer.playerId}`,
    })
    await peer.wait('command_accepted')
  }
  const config = (await game.peers[0]!.snapshot()).config
  const phase = config.rules.includes('godmode')
    ? 'waiting'
    : config.rules.includes('survival')
      ? 'eliminating'
      : config.rules.includes('serious_business')
        ? 'ranking'
        : 'judging'
  await expect
    .poll(async () => (await game.peers[0]!.snapshot()).phase, { timeout: 30_000 })
    .toBe(phase)
}

test('normal winner keeps player attribution and submission highlight on rejoin', async () => {
  const game = await start()
  try {
    await ready(game)
    game.czar!.send({ type: 'pick', submissionId: '1' })
    const outcome = await game.czar!.wait('round_won')
    expect(outcome).toMatchObject({ winningPlayerId: outcome.winnerId, winningSubmissionId: '1' })
    const snapshot = await game.czar!.snapshot()
    expect(snapshot).toMatchObject({
      winningPlayerId: outcome.winnerId,
      winningSubmissionId: '1',
    })
    expect(outcome.winnerId).not.toBe('1')
    expect(outcome.scores.find((player) => player.playerId === outcome.winnerId)?.score).toBe(1)
    expect(
      outcome.scores
        .filter((player) => player.playerId !== outcome.winnerId)
        .map((player) => player.score),
    ).toEqual([0, 0, 0])
    await game.czar!.wait('round_end')
    const settled = await game.czar!.snapshot()
    expect(settled.submissions[1]!.fills).toEqual(snapshot.submissions[1]!.fills)
    expect(settled.winningSubmissionId).toBe('1')
    await expect.poll(async () => (await game.czar!.snapshot()).round).toBe(2)
    expect(await game.czar!.snapshot()).toMatchObject({
      winningPlayerId: null,
      winningSubmissionId: null,
      submissions: [],
    })
  } finally {
    game.close()
  }
})

test('normal scoring reaches the target and ends after the final round instead of starting another', async () => {
  test.setTimeout(90_000)
  const game = await start([], 3)
  try {
    let target: string | undefined
    for (let round = 1; round <= 8; round++) {
      const initial = await game.peers[0]!.snapshot()
      game.czar = game.peers.find((peer) => peer.playerId === initial.czarId)
      const after = game.peers[0]!.events.length
      const candidates = game.peers.filter((peer) => peer !== game.czar)
      const chosen = candidates.find((peer) => peer.playerId === target) ?? candidates[0]!
      const beforePlay = await chosen.snapshot()
      const chosenCardIds = beforePlay.hand!.slice(0, beforePlay.prompt.pick).map((card) => card.id)
      await ready(game)
      const submissionId = (await game.czar!.snapshot()).submissions.find(
        (submission) =>
          submission.fills.length === chosenCardIds.length &&
          submission.fills.every((card, index) => card.id === chosenCardIds[index]),
      )!.submissionId
      game.czar!.send({ type: 'pick', submissionId })
      const outcome = await game.peers[0]!.wait('round_won', after)
      target ??= outcome.winnerId
      await game.peers[0]!.wait('round_end', after)
      if (outcome.scores.some((player) => player.score === 3)) {
        const over = await game.peers[0]!.wait('game_over', after)
        expect(over).toMatchObject({ mode: 'normal', winnerId: target })
        expect(over.finalScores.find((player) => player.playerId === target)?.score).toBe(3)
        expect(
          game.peers[0]!.events.slice(after).filter((event) => event.type === 'round_started'),
        ).toEqual([])
        return
      }
      await game.peers[0]!.wait('round_started', after)
      expect((await game.peers[0]!.snapshot()).round).toBe(round + 1)
    }
    throw new Error('The normal game did not reach its score target')
  } finally {
    game.close()
  }
})

test('Godmode resolved snapshots retain only each recipient’s answer and vote receipts', async () => {
  const game = await start(['godmode'])
  try {
    await ready(game)
    const ownIds = game.peers.map((peer) =>
      peer.events.find((event) => event.type === 'my_submission_ids'),
    )
    for (const [index, peer] of game.peers.entries()) {
      const own = ownIds[index]
      expect(own?.type).toBe('my_submission_ids')
      peer.send({
        type: 'vote',
        submissionId:
          own?.type === 'my_submission_ids' && own.submissionIds.includes('1') ? '0' : '1',
      })
    }
    await game.peers[0]!.wait('round_end')
    const receipts = await Promise.all(game.peers.map((peer) => peer.snapshot()))
    for (const [index, receipt] of receipts.entries()) {
      const own = ownIds[index]
      expect(receipt.phase).toBe('transition')
      expect(receipt.voteTally).toEqual({ '0': 1, '1': 3 })
      expect(receipt.mySubmissionIds).toEqual(
        own?.type === 'my_submission_ids' ? own.submissionIds : [],
      )
      expect(receipt.myVotedSubmissionId).toBe(receipt.mySubmissionIds.includes('1') ? '0' : '1')
      expect(receipt.mySubmissionCount).toBe(1)
      expect(receipt.submissions.every((submission) => !submission.playerId)).toBe(true)
    }
  } finally {
    game.close()
  }
})

for (const mode of ['normal', 'serious_business', 'survival', 'godmode'] as const) {
  test(`${mode} result shows the same named winning cards live and after refresh`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const game = await start(mode === 'normal' ? [] : [mode])
    try {
      const viewer = game.czar ?? game.peers[0]!
      const initial = await viewer.snapshot()
      const username = initial.scores.find((score) => score.playerId === viewer.playerId)!.username
      await page.addInitScript(
        (session) => {
          localStorage.setItem('cab_session', JSON.stringify(session))
        },
        {
          roomCode: viewer.roomCode,
          playerId: viewer.playerId,
          sessionToken: viewer.sessionToken,
          username,
          role: 'player',
          anonId: 'winner-viewer',
        },
      )
      await page.goto(`/games/${game.host.roomCode}/session`)
      await expect(page.locator('.card-prompt')).toBeVisible()
      const before = await Promise.all(game.peers.map((peer) => peer.snapshot()))
      await ready(game)
      const board = await viewer.snapshot()
      if (mode === 'normal') viewer.send({ type: 'pick', submissionId: '1' })
      else if (mode === 'serious_business') viewer.send({ type: 'rank', ranking: ['1', '0', '2'] })
      else if (mode === 'godmode') {
        const cardId = board.submissions[1]!.fills[0]!.id
        for (const [i, peer] of game.peers.entries()) {
          const ownsWinner = before[i]!.hand!.slice(0, board.prompt.pick).some(
            (card) => card.id === cardId,
          )
          peer.send({ type: 'vote', submissionId: ownsWinner ? '0' : '1' })
        }
      } else {
        for (const submissionId of ['0', '2']) {
          const turn = (await viewer.snapshot()).eliminationTurnPlayerId
          const actor = game.peers.find((peer) => peer.playerId === turn)!
          const marker = viewer.events.length
          actor.send({ type: 'eliminate', submissionId })
          await viewer.wait('card_eliminated', marker)
        }
      }
      const outcome =
        mode === 'serious_business'
          ? await viewer.wait('round_ranked')
          : await viewer.wait('round_won')
      const name = board.scores.find(
        (score) => score.playerId === outcome.winningPlayerId,
      )!.username
      const winner = page.locator('.sub-card.is-winner')
      await expect(page.locator('.winner-badge')).toContainText(name)
      await expect(winner).toHaveCount(board.prompt.pick)
      for (const card of board.submissions[1]!.fills)
        await expect(winner.filter({ hasText: card.text })).toHaveCount(1)
      if (mode === 'godmode')
        await expect(page.getByTestId('vote-tally').nth(1)).toHaveText('3 votes')
      await viewer.wait('round_end')
      await page.reload()
      await expect(page.locator('.winner-badge')).toContainText(name)
      await expect(winner).toHaveCount(board.prompt.pick)
      if (mode === 'godmode')
        await expect(page.getByTestId('vote-tally').nth(1)).toHaveText('3 votes')
      if (mode === 'survival')
        await expect(page.locator('.sub-card.is-eliminated')).toHaveCount(2 * board.prompt.pick)
      for (const card of board.submissions[1]!.fills)
        await expect(winner.filter({ hasText: card.text })).toHaveCount(1)
      if (mode === 'godmode') {
        await expect.poll(async () => (await viewer.snapshot()).round, { timeout: 20_000 }).toBe(2)
        expect(await viewer.snapshot()).toMatchObject({
          phase: 'picking',
          winningPlayerId: null,
          winningSubmissionId: null,
          mySubmissionCount: 0,
          mySubmissionIds: [],
          myVotedSubmissionId: null,
          myHasGambled: false,
        })
        expect((await viewer.snapshot()).voteTally).toBeUndefined()
      }
    } finally {
      game.close()
    }
  })
}
