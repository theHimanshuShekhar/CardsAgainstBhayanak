import { test, expect } from '@playwright/test'
import type { ServerToClientEvent } from '../../src/lib/types'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'

test('initial rate-limited synchronization retries on the same socket and restores the lobby', async ({
  browser,
}) => {
  const { packs } = (await (await fetch(`${BASE}/api/packs`)).json()) as { packs: { id: string }[] }
  const response = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'RetryHost',
      anonId: 'sync-retry-host',
      config: {
        maxPlayers: 3,
        roundsToWin: 5,
        timer: 'Off',
        packs: [packs[0]!.id],
        rules: [],
      },
    }),
  })
  expect(response.status).toBe(201)
  const session = {
    ...(await response.json()),
    username: 'RetryHost',
    role: 'player',
    anonId: 'sync-retry-host',
  }
  const context = await browser.newContext()
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/games/${session.roomCode}/ws`)
  const receive = () =>
    new Promise<ServerToClientEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Expected WebSocket response')), 5000)
      ws.addEventListener(
        'message',
        (event) => {
          clearTimeout(timer)
          resolve(JSON.parse(String(event.data)) as ServerToClientEvent)
        },
        { once: true },
      )
    })
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
        once: true,
      })
    })
    const auth = receive()
    ws.send(JSON.stringify({ type: 'auth', sessionToken: session.sessionToken }))
    expect(await auth).toMatchObject({ type: 'auth_ok' })
    const page = await context.newPage()
    await page.addInitScript(
      (session) => localStorage.setItem('cab_session', JSON.stringify(session)),
      session,
    )
    const sockets: { events: ServerToClientEvent[]; rejoins: number; closed: boolean }[] = []
    page.on('websocket', (socket) => {
      const observed = { events: [] as ServerToClientEvent[], rejoins: 0, closed: false }
      sockets.push(observed)
      socket.on('framesent', (frame) => {
        if (JSON.parse(String(frame.payload)).type === 'rejoin') observed.rejoins++
      })
      socket.on('framereceived', (frame) => observed.events.push(JSON.parse(String(frame.payload))))
      socket.on('close', () => {
        observed.closed = true
      })
    })
    // Real authenticated requests consume the shared identity's initial
    // snapshot burst immediately before the browser authenticates.
    for (let index = 0; index < 6; index++) {
      const snapshot = receive()
      ws.send(JSON.stringify({ type: 'rejoin' }))
      expect(await snapshot).toMatchObject({ type: 'lobby_snapshot' })
    }
    await page.goto(`/games/${session.roomCode}/lobby`)
    await expect
      .poll(() =>
        sockets[0]?.events.some(
          (event) =>
            event.type === 'error' &&
            event.code === 'rate_limited' &&
            (event.retryAfterMs ?? 0) > 0,
        ),
      )
      .toBe(true)
    await expect(page.locator('.player-name').filter({ hasText: 'RetryHost' })).toBeVisible()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]!.closed).toBe(false)
    expect(sockets[0]!.rejoins).toBeGreaterThanOrEqual(2)
    expect(sockets[0]!.events.some((event) => event.type === 'lobby_snapshot')).toBe(true)
  } finally {
    ws.close()
    await context.close()
  }
})
