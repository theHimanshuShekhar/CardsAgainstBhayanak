import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect } from '@playwright/test'
import type { ClientToServerEvent, ServerToClientEvent, RuleId } from '../../src/lib/types'

test.setTimeout(60_000)

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'
type Member = { roomCode: string; playerId: string; sessionToken: string }

async function post(path: string, body: unknown, token?: string) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function connect(member: Member) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/games/${member.roomCode}/ws`)
  const events: ServerToClientEvent[] = []
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    })
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
        .poll(() => events.slice(after).find((event) => event.type === type), { timeout: 10_000 })
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
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
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
      commandId: `play-${peer.playerId}`,
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

test('two restricted revotes preserve private eligibility and finish by seeded fallback', async ({
  browser,
}) => {
  const game = await start(['godmode'])
  const context = await browser.newContext()
  try {
    await ready(game)
    const snapshots = await Promise.all(game.peers.map((peer) => peer.snapshot()))
    const owned = snapshots.map((s) => s.mySubmissionIds[0]!)
    const candidates = [owned[0]!, owned[1]!].sort()
    const host = game.peers[0]!
    await context.addInitScript(
      (session) => localStorage.setItem('cab_session', JSON.stringify(session)),
      {
        ...game.host,
        username: 'ResolutionHost',
        role: 'player',
        anonId: 'resolution-host',
      },
    )
    const page = await context.newPage()
    await page.goto(`/games/${game.host.roomCode}/session`)
    await expect(page.getByTestId('vote-btn')).toHaveCount(4)
    for (let ballot = 0; ballot < 3; ballot++) {
      const marker = host.events.length
      for (const [i, peer] of game.peers.entries()) {
        const receipt = peer.events.length
        peer.send({
          type: 'vote',
          commandId: `ballot-${ballot}-${i}`,
          submissionId: owned[i === 0 || i === 2 ? 1 : 0]!,
        })
        await peer.wait('command_accepted', receipt)
      }
      if (ballot === 2) {
        const won = await host.wait('round_won', marker)
        expect(candidates).toContain(won.winningSubmissionId)
        await host.wait('round_end', marker)
        break
      }
      await expect.poll(async () => (await host.snapshot()).voteCandidateIds).toEqual(candidates)
      const state = await host.snapshot()
      expect(state.myVotedSubmissionId).toBeNull()
      expect(state.voteTally ?? {}).toEqual({})
      expect(state.mySubmissionIds).toEqual([owned[0]])
      expect(state.submissions.every((s) => s.playerId === undefined)).toBe(true)
      const reset = host.events
        .slice(marker)
        .find((e) => e.type === 'vote_tally' && Object.keys(e.votes).length === 0)
      expect(reset).toMatchObject({ voteCandidateIds: candidates })
      await expect(page.getByTestId('vote-btn').nth(Number(owned[2]))).toBeDisabled()
      await expect(page.getByTestId('vote-btn').nth(Number(owned[0]))).toBeDisabled()
      await expect(page.getByTestId('vote-btn').nth(Number(owned[1]))).toBeEnabled()
      await page.reload()
      await expect(page.getByTestId('vote-btn').nth(Number(owned[2]))).toBeDisabled()
      await expect(page.getByTestId('vote-btn').nth(Number(owned[1]))).toBeEnabled()
      for (const submissionId of [owned[2]!, owned[0]!]) {
        const receipt = host.events.length
        host.send({ type: 'vote', commandId: `invalid-${ballot}-${submissionId}`, submissionId })
        expect(await host.wait('error', receipt)).toMatchObject({
          code: 'invalid_state',
        })
        expect((await host.snapshot()).myVotedSubmissionId).toBeNull()
      }
    }
  } finally {
    await context.close()
    game.close()
  }
})

test('a second revote excludes answers that lost their lead in the preceding ballot', async () => {
  const game = await start(['godmode'], 20, true, 6)
  try {
    await ready(game)
    const owned = await Promise.all(
      game.peers.map(async (peer) => (await peer.snapshot()).mySubmissionIds[0]!),
    )
    const host = game.peers[0]!
    const choices = [
      [1, 2, 0, 0, 1, 2],
      [1, 0, 1, 0, 1, 0],
    ]
    for (const [ballot, targets] of choices.entries()) {
      for (const [i, target] of targets.entries()) {
        const peer = game.peers[i]!
        const marker = peer.events.length
        peer.send({
          type: 'vote',
          commandId: `narrow-${ballot}-${i}`,
          submissionId: owned[target]!,
        })
        await peer.wait('command_accepted', marker)
      }
      const expected = owned.slice(0, ballot === 0 ? 3 : 2).sort()
      await expect.poll(async () => (await host.snapshot()).voteCandidateIds).toEqual(expected)
    }
    const marker = host.events.length
    host.send({ type: 'vote', commandId: 'lost-lead', submissionId: owned[2]! })
    expect(await host.wait('error', marker)).toMatchObject({ code: 'invalid_state' })
    expect((await host.snapshot()).myVotedSubmissionId).toBeNull()
    for (const [i, peer] of game.peers.entries()) {
      const receipt = peer.events.length
      peer.send({ type: 'vote', commandId: `finish-${i}`, submissionId: owned[i === 1 ? 0 : 1]! })
      await peer.wait('command_accepted', receipt)
    }
    expect(await host.wait('round_won')).toMatchObject({ winningSubmissionId: owned[1] })
    await host.wait('round_end')
  } finally {
    game.close()
  }
})
