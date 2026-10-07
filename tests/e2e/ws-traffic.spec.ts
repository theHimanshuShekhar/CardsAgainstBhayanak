import { test, expect } from '@playwright/test'
import { request } from 'node:http'
import { playRound } from '../protocol'
import type { ServerToClientEvent } from '../../src/lib/types'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'

// Deliberate abuse consumes process-local IP buckets that Redis teardown
// cannot reset. Let their documented one-minute refill complete before
// unrelated files authenticate ordinary clients on the same loopback IP.
test.afterAll(async () => {
  test.setTimeout(70_000)
  await new Promise((resolve) => setTimeout(resolve, 60_000))
})

async function createRoom() {
  const { packs } = (await (await fetch(`${BASE}/api/packs`)).json()) as {
    packs: { id: string }[]
  }
  const response = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'TrafficHost',
      anonId: crypto.randomUUID(),
      config: { maxPlayers: 3, roundsToWin: 5, timer: 'Off', packs: [packs[0]!.id], rules: [] },
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { roomCode: string; sessionToken: string }
}

async function connect(code: string) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/games/${code}/ws`)
  const events: ServerToClientEvent[] = []
  let closeCode: number | undefined
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  ws.addEventListener('close', (event) => {
    closeCode = event.code
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    })
  })
  return { ws, events, closed: () => closeCode }
}

test('oversized text and binary frames close before command processing', async () => {
  const room = await createRoom()
  for (const frame of ['x'.repeat(8193), new Uint8Array(8193)]) {
    const peer = await connect(room.roomCode)
    try {
      peer.ws.send(frame)
      await expect.poll(peer.closed, { timeout: 3000 }).toBe(1009)
      expect(peer.events).toEqual([])
    } finally {
      peer.ws.close()
    }
  }
})

test('fragmented messages enforce the aggregate payload limit', async () => {
  const room = await createRoom()
  const socket = await new Promise<import('node:net').Socket>((resolve, reject) => {
    const req = request(`${BASE}/api/games/${room.roomCode}/ws`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    req.on('upgrade', (_, socket) => resolve(socket as import('node:net').Socket))
    req.on('error', reject)
    req.end()
  })
  let closeCode: number | undefined
  let received = Buffer.alloc(0)
  socket.on('data', (data) => {
    received = Buffer.concat([received, data])
    if (received.length >= 4 && received[0] === 0x88) closeCode = received.readUInt16BE(2)
  })
  // Two legal-size masked client fragments whose combined message is 8,193 bytes.
  const fragment = (length: number, opcode: number, final: boolean) => {
    const frame = Buffer.alloc(length + 8)
    frame[0] = opcode | (final ? 0x80 : 0)
    frame[1] = 0xfe
    frame.writeUInt16BE(length, 2)
    const mask = [1, 2, 3, 4]
    for (let index = 0; index < 4; index++) frame[4 + index] = mask[index]!
    for (let index = 0; index < length; index++) frame[8 + index] = 0x78 ^ mask[index % 4]!
    return frame
  }
  try {
    socket.write(fragment(4096, 1, false))
    socket.write(fragment(4097, 0, true))
    await expect.poll(() => closeCode, { timeout: 3000 }).toBe(1009)
  } finally {
    socket.destroy()
  }
})

test('rejoin budget follows the player across sockets and refills without disconnecting', async () => {
  const room = await createRoom()
  const peers = await Promise.all([connect(room.roomCode), connect(room.roomCode)])
  try {
    for (const peer of peers) {
      peer.ws.send(JSON.stringify({ type: 'auth', sessionToken: room.sessionToken }))
      await expect.poll(() => peer.events.some((event) => event.type === 'auth_ok')).toBe(true)
    }
    for (let i = 0; i < 6; i++) {
      const peer = peers[i % 2]!
      const before = peer.events.length
      peer.ws.send(JSON.stringify({ type: 'rejoin' }))
      await expect
        .poll(() => peer.events.slice(before).some((event) => event.type === 'lobby_snapshot'))
        .toBe(true)
    }
    const second = peers[1]!
    const before = second.events.length
    second.ws.send(JSON.stringify({ type: 'rejoin' }))
    await expect
      .poll(() => second.events.slice(before).find((event) => event.type === 'error'))
      .toMatchObject({
        code: 'rate_limited',
        retryAfterMs: expect.any(Number),
      })
    expect(second.ws.readyState).toBe(WebSocket.OPEN)
    second.ws.send(JSON.stringify({ type: 'ping' }))
    await expect
      .poll(() => second.events.slice(before).some((event) => event.type === 'pong'))
      .toBe(true)
    const retry = second.events.slice(before).find((event) => event.type === 'error') as {
      retryAfterMs: number
    }
    await new Promise((resolve) => setTimeout(resolve, retry.retryAfterMs + 50))
    const resumed = second.events.length
    second.ws.send(JSON.stringify({ type: 'rejoin' }))
    await expect
      .poll(() => second.events.slice(resumed).some((event) => event.type === 'lobby_snapshot'))
      .toBe(true)
  } finally {
    for (const peer of peers) peer.ws.close()
  }
})

async function upgradeStatus(code: string) {
  return await new Promise<{ status: number; retry: string | undefined; body: string }>(
    (resolve, reject) => {
      const req = request(`${BASE}/api/games/${code}/ws`, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'cf-connecting-ip': '198.51.100.77',
          'x-forwarded-for': '198.51.100.78',
        },
      })
      req.on('response', (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += String(chunk)
        })
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            retry: res.headers['retry-after'] as string | undefined,
            body,
          }),
        )
      })
      req.on('upgrade', (_, socket) => {
        socket.destroy()
        reject(new Error('Unexpected accepted upgrade'))
      })
      req.on('error', reject)
      req.end()
    },
  )
}

test('pending connection limit ignores spoofed identity headers and releases slots on close and timeout', async () => {
  test.setTimeout(25_000)
  const room = await createRoom()
  const peers: Awaited<ReturnType<typeof connect>>[] = []
  try {
    for (let i = 0; i < 16; i++) peers.push(await connect(room.roomCode))
    const denied = await upgradeStatus(room.roomCode)
    expect(denied.status).toBe(429)
    expect(denied.retry).toBe('15')
    expect(JSON.parse(denied.body)).toMatchObject({ code: 'rate_limited', retryAfterMs: 15_000 })
    peers[0]!.ws.close()
    await expect.poll(peers[0]!.closed).toBe(1005)
    peers.push(await connect(room.roomCode))
    await expect.poll(peers[1]!.closed, { timeout: 17_000 }).toBe(1008)
    const recovered = await connect(room.roomCode)
    peers.push(recovered)
    recovered.ws.send(JSON.stringify({ type: 'auth', sessionToken: room.sessionToken }))
    await expect.poll(() => recovered.events.some((event) => event.type === 'auth_ok')).toBe(true)
  } finally {
    for (const peer of peers) peer.ws.close()
  }
})

test('bounded command flood is rejected while a separate room completes a round', async () => {
  test.setTimeout(60_000)
  const attacker = await createRoom()
  const observerRoom = await createRoom()
  const flood = await connect(attacker.roomCode)
  const observer = await connect(observerRoom.roomCode)
  try {
    for (const [peer, room] of [
      [flood, attacker],
      [observer, observerRoom],
    ] as const) {
      peer.ws.send(JSON.stringify({ type: 'auth', sessionToken: room.sessionToken }))
      await expect.poll(() => peer.events.some((event) => event.type === 'auth_ok')).toBe(true)
    }
    const healthy = await playRound(BASE, {
      whilePicking: async () => {
        for (let i = 0; i < 100; i++) flood.ws.send(JSON.stringify({ type: 'rejoin' }))
        await expect
          .poll(
            () =>
              flood.events.filter(
                (event) => event.type === 'error' && event.code === 'rate_limited',
              ).length,
          )
          .toBeGreaterThan(90)
        expect(
          flood.events.filter((event) => event.type === 'lobby_snapshot').length,
        ).toBeLessThanOrEqual(6)
        observer.ws.send(JSON.stringify({ type: 'rejoin' }))
        observer.ws.send(JSON.stringify({ type: 'ping' }))
        await expect
          .poll(() => observer.events.some((event) => event.type === 'lobby_snapshot'), {
            timeout: 3000,
          })
          .toBe(true)
        await expect
          .poll(() => observer.events.some((event) => event.type === 'pong'), { timeout: 3000 })
          .toBe(true)
        expect((await fetch(`${BASE}/api/healthz`)).status).toBe(200)
      },
    })
    expect(healthy.roundWon).toBe(true)
    expect(healthy.reachedRound2).toBe(true)
  } finally {
    flood.ws.close()
    observer.ws.close()
  }
})

test('gameplay command budget is shared across sockets and keeps correlation IDs', async () => {
  const room = await createRoom()
  const peers = await Promise.all([connect(room.roomCode), connect(room.roomCode)])
  let denied = 0
  try {
    for (const peer of peers) {
      peer.ws.send(JSON.stringify({ type: 'auth', sessionToken: room.sessionToken }))
      await expect.poll(() => peer.events.some((event) => event.type === 'auth_ok')).toBe(true)
    }
    for (let index = 0; index < 70; index++) {
      const peer = peers[index % 2]!
      const commandId = `budget-play-${index}`
      peer.ws.send(JSON.stringify({ type: 'play', cardIds: ['not-a-card'], commandId }))
      await expect
        .poll(
          () =>
            peer.events.find((event) => event.type === 'error' && event.commandId === commandId),
          { intervals: [1, 5, 10], timeout: 3000 },
        )
        .toBeTruthy()
      const reply = peer.events.find(
        (event) => event.type === 'error' && event.commandId === commandId,
      )!
      expect(reply).toMatchObject({ commandId })
      if (reply.type === 'error' && reply.code === 'rate_limited') {
        denied++
        expect(reply.retryAfterMs).toBeGreaterThan(0)
      } else expect(reply).toMatchObject({ code: 'invalid_state' })
    }
    expect(denied).toBeGreaterThan(0)
    peers[0]!.ws.send(JSON.stringify({ type: 'ping' }))
    await expect.poll(() => peers[0]!.events.some((event) => event.type === 'pong')).toBe(true)
  } finally {
    for (const peer of peers) peer.ws.close()
  }
})

test('malformed pre-authentication frame floods close with a retryable error', async () => {
  const room = await createRoom()
  const peer = await connect(room.roomCode)
  try {
    for (let index = 0; index < 136; index++) peer.ws.send('{')
    await expect.poll(peer.closed).toBe(1008)
    expect(
      peer.events.find((event) => event.type === 'error' && event.code === 'rate_limited'),
    ).toMatchObject({ retryAfterMs: expect.any(Number) })
    expect(peer.events.some((event) => event.type === 'auth_ok')).toBe(false)
  } finally {
    peer.ws.close()
  }
})

test('authentication attempts share an IP budget across fresh connections', async () => {
  test.setTimeout(20_000)
  const room = await createRoom()
  const errors: ServerToClientEvent[] = []
  for (let batch = 0; batch < 9; batch++) {
    const peers = await Promise.all(Array.from({ length: 8 }, () => connect(room.roomCode)))
    try {
      await Promise.all(
        peers.map(async (peer) => {
          peer.ws.send(JSON.stringify({ type: 'auth', sessionToken: 'invalid-token' }))
          await expect
            .poll(() =>
              peer.events.find((event) => event.type === 'auth_error' || event.type === 'error'),
            )
            .toBeTruthy()
          errors.push(
            peer.events.find((event) => event.type === 'auth_error' || event.type === 'error')!,
          )
          await expect.poll(peer.closed).toBe(1008)
        }),
      )
    } finally {
      for (const peer of peers) peer.ws.close()
    }
  }
  expect(
    errors.some((event) => event.type === 'auth_error' && event.code === 'invalid_token'),
  ).toBe(true)
  expect(
    errors.some(
      (event) =>
        event.type === 'error' && event.code === 'rate_limited' && (event.retryAfterMs ?? 0) > 0,
    ),
  ).toBe(true)
})
