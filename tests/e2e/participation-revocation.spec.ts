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

async function join(roomCode: string, username: string): Promise<Member> {
  const response = await post(`/api/games/${roomCode}/join`, {
    username,
    anonId: `participation-${username}`,
    role: 'player',
  })
  expect(response.status).toBe(200)
  return { ...(await response.json()), roomCode }
}

async function connect(member: Member, authenticate = true) {
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
      const after = events.length
      peer.send({ type: 'rejoin' })
      return (await peer.wait('state_snapshot', after)).state
    },
  }
  if (authenticate) {
    peer.send({ type: 'auth', sessionToken: member.sessionToken })
    await peer.wait('auth_ok')
  }
  return peer
}

async function start() {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const response = await post('/api/games', {
    username: 'ParticipationHost',
    anonId: 'participation-host',
    config: {
      maxPlayers: 10,
      roundsToWin: 20,
      timer: 'Off',
      packs: [pack.id],
      rules: ['never_have_i_ever'],
    },
  })
  expect(response.status).toBe(201)
  const host = (await response.json()) as Member
  const members = [host, await join(host.roomCode, 'Second'), await join(host.roomCode, 'Third')]
  const peers = await Promise.all(members.map((member) => connect(member)))
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  await peers[0]!.wait('round_started')
  const initial = await peers[0]!.snapshot()
  const actor = peers.find((peer) => peer.playerId !== initial.czarId)!
  const observer = peers.find((peer) => peer !== actor)!
  return { host, peers, actor, observer }
}

test('HTTP leave revokes every socket of the identity and rejects its old token', async () => {
  const game = await start()
  const secondSocket = await connect(game.actor)
  try {
    expect(
      (await post(`/api/games/${game.host.roomCode}/leave`, {}, game.actor.sessionToken)).status,
    ).toBe(204)
    expect((await game.observer.wait('player_left')).playerId).toBe(game.actor.playerId)
    for (const peer of [game.actor, secondSocket]) {
      await expect.poll(() => peer.ws.readyState, { timeout: 2_000 }).toBe(WebSocket.CLOSED)
      expect(peer.events).toContainEqual({
        type: 'auth_error',
        code: 'player_dropped',
        message: 'player dropped',
      })
    }
    const reconnect = await connect(game.actor, false)
    reconnect.send({ type: 'auth', sessionToken: game.actor.sessionToken })
    expect(await reconnect.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
    await expect.poll(() => reconnect.ws.readyState).toBe(WebSocket.CLOSED)
    expect((await game.observer.snapshot()).scores.map((p) => p.playerId)).not.toContain(
      game.actor.playerId,
    )
  } finally {
    for (const peer of [...game.peers, secondSocket]) peer.ws.close()
  }
})

test('queued players cannot issue any game mutation before round activation', async () => {
  const game = await start()
  const queued = await connect(await join(game.host.roomCode, 'Queued'))
  try {
    const before = await game.observer.snapshot()
    const commands: ClientToServerEvent[] = [
      { type: 'play', cardIds: [before.hand![0]!.id], commandId: 'queued-play' },
      { type: 'gamble' },
      { type: 'pick', submissionId: '0', commandId: 'queued-pick' },
      { type: 'rank', ranking: ['0', '1', '2'] },
      { type: 'vote', submissionId: '0', commandId: 'queued-vote' },
      { type: 'eliminate', submissionId: '0' },
      { type: 'redraw' },
      { type: 'confess_discard', cardId: before.hand![0]!.id },
      { type: 'happy_ending' },
    ]
    for (const command of commands) {
      const after = queued.events.length
      queued.send(command)
      expect(await queued.wait('error', after)).toMatchObject({
        code: 'not_authorized',
        ...('commandId' in command ? { commandId: command.commandId } : {}),
      })
    }
    expect(await game.observer.snapshot()).toEqual(before)
    expect((await queued.snapshot()).hand).toBeUndefined()
    expect(queued.events.some((event) => event.type === 'command_accepted')).toBe(false)
  } finally {
    for (const peer of [...game.peers, queued]) peer.ws.close()
  }
})

test('a queued reconnect waits for round activation before becoming a participant', async () => {
  const game = await start()
  const member = await join(game.host.roomCode, 'QueuedReconnect')
  const queued = await connect(member)
  let reconnect: Awaited<ReturnType<typeof connect>> | undefined
  try {
    queued.ws.close()
    await expect.poll(() => queued.ws.readyState).toBe(WebSocket.CLOSED)
    reconnect = await connect(member)
    const before = await game.observer.snapshot()
    expect(before.expected).toBe(2)
    const after = reconnect.events.length
    reconnect.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    expect(await reconnect.wait('error', after)).toMatchObject({ code: 'not_authorized' })

    for (const peer of game.peers) {
      const snapshot = await peer.snapshot()
      if (peer.playerId === snapshot.czarId) continue
      peer.send({
        type: 'play',
        cardIds: snapshot.hand!.slice(0, snapshot.prompt.pick).map((card) => card.id),
      })
    }
    await expect
      .poll(async () => (await game.observer.snapshot()).phase, { timeout: 10_000 })
      .toBe('judging')
    const czar = game.peers.find((peer) => peer.playerId === before.czarId)!
    czar.send({ type: 'pick', submissionId: '0' })
    expect((await reconnect.wait('round_end')).activatedPlayers).toContain(member.playerId)
    await reconnect.wait('round_started')
    const active = await reconnect.snapshot()
    expect(active.hand).toHaveLength(10)
    const activeAfter = reconnect.events.length
    reconnect.send({ type: 'confess_discard', cardId: active.hand![0]!.id })
    expect((await reconnect.wait('hand_update', activeAfter)).hand).toHaveLength(10)
  } finally {
    for (const peer of [...game.peers, queued, ...(reconnect ? [reconnect] : [])]) peer.ws.close()
  }
})

test('WebSocket leave revokes sibling sockets and blocks commands pipelined after leave', async () => {
  const game = await start()
  const sibling = await connect(game.actor)
  try {
    const before = await game.actor.snapshot()
    game.actor.send({ type: 'leave' })
    game.actor.send({
      type: 'play',
      cardIds: before.hand!.slice(0, before.prompt.pick).map((card) => card.id),
      commandId: 'after-leave',
    })
    game.actor.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    game.actor.send({ type: 'rejoin' })
    expect((await game.observer.wait('player_left')).playerId).toBe(game.actor.playerId)
    for (const peer of [game.actor, sibling])
      await expect.poll(() => peer.ws.readyState).toBe(WebSocket.CLOSED)
    const after = await game.observer.snapshot()
    expect(after).toMatchObject({ round: before.round, phase: 'picking', submitted: 0 })
    expect(game.actor.events).not.toContainEqual({
      type: 'command_accepted',
      commandId: 'after-leave',
    })
    expect(game.observer.events.some((event) => event.type === 'player_played')).toBe(false)
    expect(game.observer.events.filter((event) => event.type === 'player_left')).toHaveLength(1)
  } finally {
    for (const peer of [...game.peers, sibling]) peer.ws.close()
  }
})

test('closing one socket leaves its sibling an active participant', async () => {
  const game = await start()
  const sibling = await connect(game.actor)
  try {
    game.actor.ws.close()
    await expect.poll(() => game.actor.ws.readyState).toBe(WebSocket.CLOSED)
    const before = await sibling.snapshot()
    sibling.send({ type: 'confess_discard', cardId: before.hand![0]!.id })
    const update = await sibling.wait('hand_update')
    expect(update.hand.map((card) => card.id)).not.toContain(before.hand![0]!.id)
    sibling.send({
      type: 'play',
      cardIds: update.hand.slice(0, before.prompt.pick).map((card) => card.id),
      commandId: 'sibling-play',
    })
    expect(await sibling.wait('command_accepted')).toMatchObject({ commandId: 'sibling-play' })
    expect((await game.observer.snapshot()).submitted).toBe(1)
  } finally {
    for (const peer of [...game.peers, sibling]) peer.ws.close()
  }
})

test('HTTP leave racing authentication cannot bind or restore a dropped identity', async () => {
  const game = await start()
  const contenders: Awaited<ReturnType<typeof connect>>[] = []
  try {
    for (let i = 0; i < 6; i++) {
      const member = await join(game.host.roomCode, `Racing${i}`)
      const contender = await connect(member, false)
      contenders.push(contender)
      contender.send({ type: 'auth', sessionToken: member.sessionToken })
      expect(
        (await post(`/api/games/${game.host.roomCode}/leave`, {}, member.sessionToken)).status,
      ).toBe(204)
      await expect.poll(() => contender.ws.readyState, { timeout: 2_000 }).toBe(WebSocket.CLOSED)
      expect(contender.events).toContainEqual({
        type: 'auth_error',
        code: 'player_dropped',
        message: 'player dropped',
      })
      const reconnect = await connect(member, false)
      contenders.push(reconnect)
      reconnect.send({ type: 'auth', sessionToken: member.sessionToken })
      expect(await reconnect.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
    }
    expect((await game.observer.snapshot()).expected).toBe(2)
  } finally {
    for (const peer of [...game.peers, ...contenders]) peer.ws.close()
  }
})

test('a disconnected queued player still drops after the grace deadline', async () => {
  test.setTimeout(45_000)
  const game = await start()
  const member = await join(game.host.roomCode, 'QueuedTimeout')
  const queued = await connect(member)
  let reconnect: Awaited<ReturnType<typeof connect>> | undefined
  try {
    queued.ws.close()
    await expect
      .poll(() => game.observer.events.find((event) => event.type === 'player_left'), {
        timeout: 35_000,
        intervals: [500],
      })
      .toMatchObject({ playerId: member.playerId })
    reconnect = await connect(member, false)
    reconnect.send({ type: 'auth', sessionToken: member.sessionToken })
    expect(await reconnect.wait('auth_error')).toMatchObject({ code: 'player_dropped' })
  } finally {
    for (const peer of [...game.peers, queued, ...(reconnect ? [reconnect] : [])]) peer.ws.close()
  }
})
