import { test, expect } from '@playwright/test'
import type { ServerToClientEvent } from '../../src/lib/types'
import { playRound } from '../protocol'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'

const malformedFrames: unknown[] = [
  '{',
  null,
  42,
  true,
  JSON.stringify('hello'),
  [],
  {},
  { type: null },
  { type: 123 },
  { type: 'unknown' },
  { type: 'auth' },
  { type: 'auth', sessionToken: null },
  { type: 'auth', sessionToken: '' },
  { type: 'auth', sessionToken: 'token', anonId: 42 },
  { type: 'auth', sessionToken: 'x'.repeat(4097) },
  { type: 'auth', sessionToken: 'token', extra: 'unexpected' },
  ...['play', 'rank'].flatMap((type) => {
    const field = type === 'play' ? 'cardIds' : 'ranking'
    return [
      { type },
      ...[null, 1, 'card', [], [null], [1], [''], ['x'.repeat(257)], ['a', 'b', 'c', 'd']].map(
        (value) => ({
          type,
          [field]: value,
        }),
      ),
    ]
  }),
  ...['pick', 'vote', 'eliminate', 'confess_discard'].flatMap((type) => {
    const field = type === 'confess_discard' ? 'cardId' : 'submissionId'
    return [
      { type },
      ...[null, 1, [], '', 'x'.repeat(257)].map((value) => ({ type, [field]: value })),
    ]
  }),
  ...['rejoin', 'gamble', 'redraw', 'happy_ending', 'leave', 'ping'].map((type) => ({
    type,
    extra: 'unexpected',
  })),
]

async function connect(code: string) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/games/${code}/ws`)
  const events: ServerToClientEvent[] = []
  ws.addEventListener('message', (event) => events.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
      once: true,
    })
  })
  return {
    ws,
    async reply(frame: unknown, type: ServerToClientEvent['type']) {
      const before = events.length
      ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
      await expect
        .poll(() => events.slice(before).find((event) => event.type === type), {
          timeout: 3000,
        })
        .toBeTruthy()
      return events.slice(before).find((event) => event.type === type)!
    },
  }
}

async function createRoom() {
  const packs = (await (await fetch(`${BASE}/api/packs`)).json()) as { packs: { id: string }[] }
  const response = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'ValidationHost',
      anonId: 'validation-host',
      config: {
        maxPlayers: 3,
        roundsToWin: 5,
        timer: 'Off',
        packs: [packs.packs[0]!.id],
        rules: [],
      },
    }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { roomCode: string; sessionToken: string }
}

test('malformed unauthenticated and authenticated commands leave other rooms playable', async () => {
  test.setTimeout(60_000)
  const room = await createRoom()
  const peer = await connect(room.roomCode)
  try {
    const healthyRoom = await playRound(BASE, {
      whilePicking: async () => {
        for (const frame of malformedFrames) {
          expect(await peer.reply(frame, 'error'), JSON.stringify(frame)).toEqual({
            type: 'error',
            code: 'invalid_state',
            message: 'Invalid command',
          })
        }
        expect(await peer.reply({ type: 'ping' }, 'error')).toMatchObject({
          code: 'not_authorized',
        })
        await peer.reply({ type: 'auth', sessionToken: room.sessionToken }, 'auth_ok')
        for (const frame of malformedFrames) {
          expect(await peer.reply(frame, 'error'), JSON.stringify(frame)).toEqual({
            type: 'error',
            code: 'invalid_state',
            message: 'Invalid command',
          })
        }
        expect(await peer.reply({ type: 'ping' }, 'pong')).toEqual({ type: 'pong' })
        expect((await fetch(`${BASE}/api/healthz`)).status).toBe(200)
      },
    })
    expect(healthyRoom.roundWon).toBe(true)
    expect(healthyRoom.reachedRound2).toBe(true)
  } finally {
    peer.ws.close()
  }
})

test('a rejected async command returns a safe error and leaves the server usable', async () => {
  test.setTimeout(60_000)
  const room = await createRoom()
  const peer = await connect(room.roomCode)
  try {
    const healthyRoom = await playRound(BASE, {
      whilePicking: async () => {
        await peer.reply(
          { type: 'auth', sessionToken: room.sessionToken, anonId: 'validation-host' },
          'auth_ok',
        )
        // Valid protocol shape, but the engine rejects an ID absent from the deck.
        // The thrown error includes this private value; the protocol must not echo it.
        expect(
          await peer.reply(
            { type: 'play', cardIds: ['private-card-id-do-not-log\nprivate-multiline-marker'] },
            'error',
          ),
        ).toEqual({
          type: 'error',
          code: 'internal_error',
          message: 'Command failed',
        })
        expect(await peer.reply({ type: 'ping' }, 'pong')).toEqual({ type: 'pong' })
        expect(await peer.reply({ type: 'rejoin' }, 'lobby_snapshot')).toMatchObject({
          gameStatus: 'lobby',
        })
        expect((await fetch(`${BASE}/api/healthz`)).status).toBe(200)
      },
    })
    expect(healthyRoom.reachedRound2).toBe(true)
  } finally {
    peer.ws.close()
  }
})
