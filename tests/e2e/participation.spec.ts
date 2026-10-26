import { requestStateSnapshot } from '../ws-snapshot'
import { test, expect } from '@playwright/test'
import type { ClientToServerEvent, ServerToClientEvent } from '../../src/lib/types'

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
    ws,
    events,
    send(event: ClientToServerEvent) {
      ws.send(JSON.stringify(event))
    },
    async wait<T extends ServerToClientEvent['type']>(type: T, after = 0) {
      await expect
        .poll(() => events.slice(after).find((event) => event.type === type), {
          timeout: 10_000,
          intervals: [5],
        })
        .toBeTruthy()
      return events.slice(after).find((event) => event.type === type) as Extract<
        ServerToClientEvent,
        { type: T }
      >
    },
    async snapshot() {
      return requestStateSnapshot(ws, events)
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return
      const closed = new Promise<void>((resolve) =>
        ws.addEventListener('close', () => resolve(), { once: true }),
      )
      ws.close()
      await closed
    },
  }
  peer.send({ type: 'auth', sessionToken: member.sessionToken })
  await peer.wait('auth_ok')
  return peer
}

async function room(rules: Array<'godmode'> = []) {
  const { packs } = await (await fetch(BASE + '/api/packs')).json()
  const pack = packs.find((pack: { name: string }) => /base/i.test(pack.name))!
  const response = await post('/api/games', {
    username: 'Host',
    anonId: 'participation-host',
    config: { maxPlayers: 10, roundsToWin: 3, timer: 'Off', packs: [pack.id], rules },
  })
  expect(response.status).toBe(201)
  const host: Member = await response.json()
  const members = [host]
  const peers: Awaited<ReturnType<typeof connect>>[] = []
  const join = async (username: string, role: string) => {
    const joined = await post(`/api/games/${host.roomCode}/join`, {
      username,
      role,
      anonId: username,
    })
    expect(joined.status).toBe(200)
    const member: Member = { ...(await joined.json()), roomCode: host.roomCode }
    members.push(member)
    return member
  }
  await join('Alice', 'player')
  await join('Bob', 'player')
  await join('Observer', 'spectator')
  peers.push(...(await Promise.all(members.map(connect))))
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  await peers[0]!.wait('round_started')
  await join('Later', 'player')
  peers.push(await connect(members[4]!))
  return { host, members, peers }
}

for (const godmode of [false, true]) {
  test(`spectator and queued reconnects preserve ${godmode ? 'voting' : 'submission'} quorum and activate only at round end`, async () => {
    const { members, peers } = await room(godmode ? ['godmode'] : [])
    try {
      for (const index of [3, 4]) {
        await peers[index]!.close()
        peers[index] = await connect(members[index]!)
        const snapshot = await peers[index]!.snapshot()
        expect(snapshot.hand).toBeUndefined()
        expect(snapshot.expected).toBe(godmode ? 3 : 2)
        expect(snapshot.czarId).not.toBe(members[index]!.playerId)
      }
      const initial = await peers[0]!.snapshot()
      for (let i = 0; i < 3; i++) {
        if (members[i]!.playerId === initial.czarId) continue
        const snapshot = await peers[i]!.snapshot()
        peers[i]!.send({
          type: 'play',
          cardIds: snapshot.hand!.slice(0, snapshot.prompt.pick).map((card) => card.id),
        })
      }
      await peers[0]!.wait('reveal_start')
      const after = peers[3]!.events.length
      peers[3]!.send({ type: 'vote', submissionId: '0' })
      expect(await peers[3]!.wait('error', after)).toMatchObject({ code: 'spectator_action' })
      await expect
        .poll(async () => (await peers[0]!.snapshot()).phase)
        .toBe(godmode ? 'waiting' : 'judging')
      const activationAfter = peers[4]!.events.length
      if (godmode) {
        for (let index = 0; index < 3; index++) {
          const snapshot = await peers[index]!.snapshot()
          const candidate = snapshot.submissions.find(
            (submission) => !snapshot.mySubmissionIds.includes(submission.submissionId),
          )!
          peers[index]!.send({ type: 'vote', submissionId: candidate.submissionId })
        }
      } else {
        const czar = members.findIndex((member) => member.playerId === initial.czarId)
        const snapshot = await peers[czar]!.snapshot()
        peers[czar]!.send({ type: 'pick', submissionId: snapshot.submissions[0]!.submissionId })
      }
      const ended = await peers[4]!.wait('round_end', activationAfter)
      expect(ended.activatedPlayers).toEqual([members[4]!.playerId])
      const hand = await peers[4]!.wait('hand_update', activationAfter)
      expect(hand.hand).toHaveLength(10)
      expect(peers[4]!.events.indexOf(hand)).toBeLessThan(peers[4]!.events.indexOf(ended))
      expect((await peers[3]!.snapshot()).hand).toBeUndefined()
    } finally {
      await Promise.all(peers.map((peer) => peer.close()))
    }
  })
}

for (const mode of ['lobby', 'rematch'] as const) {
  test(`${mode} reset preserves spectator, queued and disconnected participation`, async () => {
    const { host, members, peers } = await room()
    try {
      // End is a public engine fixture trigger; all assertions use the same
      // HTTP/WS boundary as real clients, never stored Redis values.
      const { endGame } = await import('../../src/lib/game-engine')
      await endGame(host.roomCode, 'normal', host.playerId)
      await peers[0]!.wait('game_over')
      await Promise.all([1, 3, 4].map((index) => peers[index]!.close()))
      const after = peers[0]!.events.length
      expect(
        (await post(`/api/games/${host.roomCode}/reset`, { mode }, host.sessionToken)).status,
      ).toBe(204)
      await peers[0]!.wait('game_reset', after)
      if (mode === 'lobby') {
        const lobby = await peers[0]!.wait('lobby_snapshot', after)
        for (const [index, status] of [
          [1, 'active'],
          [3, 'spectator'],
          [4, 'queued'],
        ] as const) {
          expect(
            lobby.players.find((player) => player.id === members[index]!.playerId),
          ).toMatchObject({
            status,
            connectionStatus: 'grace',
          })
        }
        expect(
          (await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status,
        ).toBe(204)
      }
      await peers[0]!.wait('round_started', after)
      for (const index of [1, 3, 4]) peers[index] = await connect(members[index]!)
      for (const index of [3, 4]) {
        const snapshot = await peers[index]!.snapshot()
        expect(snapshot.hand).toBeUndefined()
        expect(snapshot.czarId).not.toBe(members[index]!.playerId)
        expect(snapshot.expected).toBe(2)
      }
      expect((await peers[1]!.snapshot()).hand).toHaveLength(10)
      const rejectedAfter = peers[4]!.events.length
      peers[4]!.send({ type: 'play', cardIds: ['unavailable'] })
      expect(await peers[4]!.wait('error', rejectedAfter)).toMatchObject({ code: 'not_authorized' })
    } finally {
      await Promise.all(peers.map((peer) => peer.close()))
    }
  })
}

test('reset does not cancel the grace deadline of a disconnected spectator', async () => {
  test.setTimeout(45_000)
  const { host, members, peers } = await room()
  try {
    const { endGame } = await import('../../src/lib/game-engine')
    await endGame(host.roomCode, 'normal', host.playerId)
    await peers[0]!.wait('game_over')
    await peers[3]!.close()
    const after = peers[0]!.events.length
    expect(
      (await post(`/api/games/${host.roomCode}/reset`, { mode: 'lobby' }, host.sessionToken))
        .status,
    ).toBe(204)
    await peers[0]!.wait('game_reset', after)
    // Real grace clock: the old connection's expiry remains authoritative
    // across reset, while connected room members continue receiving events.
    await expect
      .poll(
        () =>
          peers[0]!.events
            .slice(after)
            .find(
              (event) => event.type === 'player_left' && event.playerId === members[3]!.playerId,
            ),
        { timeout: 35_000, intervals: [100] },
      )
      .toBeTruthy()
  } finally {
    await Promise.all(peers.map((peer) => peer.close()))
  }
})
