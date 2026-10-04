import { test, expect } from '@playwright/test'
import type { ClientToServerEvent, ServerToClientEvent, RuleId } from '../../src/lib/types'

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
      const after = events.length
      peer.send({ type: 'rejoin' })
      return (await peer.wait('state_snapshot', after)).state
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

async function startRoom(rules: RuleId[] = []) {
  const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
    packs: { id: string; name: string }[]
  }
  const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
  const created = await post('/api/games', {
    username: 'PrivacyHost',
    anonId: 'privacy-host',
    config: { maxPlayers: 10, roundsToWin: 5, timer: 'Off', packs: [pack.id], rules },
  })
  expect(created.status).toBe(201)
  const host: Member = await created.json()
  const members = [host]
  for (const [username, role] of [
    ['Second', 'player'],
    ['Third', 'player'],
    ['Fourth', 'player'],
    ['Observer', 'spectator'],
  ]) {
    const response = await post(`/api/games/${host.roomCode}/join`, {
      username,
      anonId: `privacy-${username}`,
      role,
    })
    expect(response.status).toBe(200)
    members.push({ ...(await response.json()), roomCode: host.roomCode })
  }
  const peers = await Promise.all(members.map(connect))
  expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
  await peers[0]!.wait('round_started')
  const initial = await Promise.all(peers.map((peer) => peer.snapshot()))
  const czar = members.findIndex((member) => member.playerId === initial[0]!.czarId)
  const submitters = members.flatMap((_, i) => (i !== czar && i < 4 ? [i] : []))
  return {
    members,
    peers,
    initial,
    czar,
    submitters,
    async reconnect(index: number) {
      await peers[index]!.close()
      peers[index] = await connect(members[index]!)
      return peers[index]!.snapshot()
    },
    async play(index: number) {
      const peer = peers[index]!
      const after = peer.events.length
      peer.send({
        type: 'play',
        cardIds: initial[index]!.hand!.slice(0, initial[index]!.prompt.pick).map((card) => card.id),
      })
      await peer.wait('player_played', after)
    },
    async close() {
      await Promise.all(peers.map((peer) => peer.close()))
    },
  }
}

test('rejoining players and spectators see picking progress without unshuffled answers or identities', async () => {
  const room = await startRoom()
  try {
    const owner = room.submitters[0]!
    await room.play(owner)
    for (const index of [owner, room.czar, room.submitters[1]!, 4]) {
      const snapshot = await room.reconnect(index)
      expect(snapshot.phase).toBe('picking')
      expect(snapshot.submitted).toBe(1)
      if (index !== 4) expect(snapshot.expected).toBe(3)
      // No provisional index IDs: only the final shuffled order assigns them.
      expect(snapshot.submissions).toEqual([])
      expect(snapshot.revealIndex).toBe(0)
      expect(snapshot.mySubmissionCount).toBe(index === owner ? 1 : 0)
      if (index === 4) expect(snapshot.hand).toBeUndefined()
      else expect(snapshot.hand).toHaveLength(index === owner ? 10 - snapshot.prompt.pick : 10)
    }
  } finally {
    await room.close()
  }
})

test('rejoins expose only scheduled reveals and preserve submission IDs through the last reveal', async () => {
  const room = await startRoom()
  try {
    const monitor = room.peers[room.submitters[2]!]!
    const recipients = [room.czar, room.submitters[0]!, 4]
    for (const index of room.submitters) await room.play(index)
    await monitor.wait('reveal_start')
    const faceDown = await Promise.all(recipients.map((index) => room.reconnect(index)))
    for (const snapshot of faceDown) {
      expect(snapshot.phase).toBe('reveal')
      expect(snapshot.revealIndex).toBe(0)
      expect(snapshot.submissions).toEqual([
        { submissionId: '0', fills: [] },
        { submissionId: '1', fills: [] },
        { submissionId: '2', fills: [] },
      ])
    }

    const first = await monitor.wait('card_revealed')
    expect(first.submissionIndex).toBe(0)
    const partial = await Promise.all(recipients.map((index) => room.reconnect(index)))
    for (const snapshot of partial) {
      expect(snapshot.phase).toBe('reveal')
      expect(snapshot.revealIndex).toBe(1)
      expect(snapshot.submissions).toEqual([
        { submissionId: '0', fills: first.fills },
        { submissionId: '1', fills: [] },
        { submissionId: '2', fills: [] },
      ])
    }

    // Read live broadcasts independently of the snapshots to check ordering.
    await expect
      .poll(() => monitor.events.filter((event) => event.type === 'card_revealed').length)
      .toBe(3)
    const revealed = monitor.events.filter((event) => event.type === 'card_revealed')
    expect(revealed.map((event) => event.submissionIndex)).toEqual([0, 1, 2])
    const completed = await Promise.all(recipients.map((index) => room.reconnect(index)))
    for (const snapshot of completed) {
      expect(snapshot.phase).toBe('judging')
      expect(snapshot.revealIndex).toBe(3)
      expect(snapshot.submissions).toEqual(
        revealed.map((event) => ({
          submissionId: String(event.submissionIndex),
          fills: event.fills,
        })),
      )
    }
    // The stable IDs remain valid public commands after reconnect.
    room.peers[room.czar]!.send({ type: 'pick', submissionId: '1' })
    expect((await monitor.wait('round_won')).submissionId).toBe('1')
  } finally {
    await room.close()
  }
})

test('a refreshed spectator sees unrevealed slots as card backs until their live reveal', async ({
  page,
}) => {
  const room = await startRoom()
  try {
    const spectator = room.members[4]!
    await page.addInitScript((member) => {
      localStorage.setItem(
        'cab_session',
        JSON.stringify({
          ...member,
          username: 'Observer',
          role: 'spectator',
          anonId: 'privacy-observer',
        }),
      )
      const NativeSocket = window.WebSocket
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          this.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data))
            // Hold live flips so the assertions observe the reconnect
            // snapshot even if the next server reveal reaches the browser.
            if (message.type === 'card_revealed') event.stopImmediatePropagation()
          })
        }
      }
    }, spectator)
    await page.goto(`/games/${spectator.roomCode}/session`)
    await expect(page.locator('.score-chip')).toHaveCount(5)
    for (const index of room.submitters) await room.play(index)
    await room.peers[room.submitters[2]!]!.wait('card_revealed')
    await page.reload()
    const pick = room.initial[0]!.prompt.pick
    await expect(page.locator('.sub-card')).toHaveCount(3 * pick, { timeout: 2_000 })
    await expect(page.locator('.hidden-card')).toHaveCount(2 * pick)
    await expect(page.locator('.flip-reveal .card-response')).toHaveCount(pick)
  } finally {
    await page.close()
    await room.close()
  }
})

for (const [rule, phase] of [
  ['godmode', 'waiting'],
  ['survival', 'eliminating'],
  ['serious_business', 'ranking'],
] as const) {
  test(`rejoining players and spectators retain completed answers during ${rule}`, async () => {
    const room = await startRoom([rule])
    try {
      const monitor = room.peers[room.submitters.at(-1)!]!
      for (const index of room.submitters) await room.play(index)
      await expect
        .poll(() => monitor.events.filter((event) => event.type === 'card_revealed').length)
        .toBe(room.submitters.length)
      const revealed = monitor.events.filter((event) => event.type === 'card_revealed')
      for (const index of [room.submitters[0]!, 4]) {
        const snapshot = await room.reconnect(index)
        expect(snapshot.phase).toBe(phase)
        expect(snapshot.revealIndex).toBe(room.submitters.length)
        expect(snapshot.submissions).toEqual(
          revealed.map((event) => ({
            submissionId: String(event.submissionIndex),
            fills: event.fills,
          })),
        )
      }
    } finally {
      await room.close()
    }
  })
}

test('a delayed partial snapshot preserves live reveals from the same round', async ({ page }) => {
  const room = await startRoom()
  try {
    await page.addInitScript((member) => {
      localStorage.setItem(
        'cab_session',
        JSON.stringify({
          ...member,
          username: 'Observer',
          role: 'spectator',
          anonId: 'privacy-observer',
        }),
      )
      const NativeSocket = window.WebSocket
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          const boundary = { socket: this, holdNext: false, held: '' }
          ;(window as unknown as { privacyBoundary: typeof boundary }).privacyBoundary = boundary
          this.addEventListener('message', (event) => {
            if (JSON.parse(String(event.data)).type === 'state_snapshot' && boundary.holdNext) {
              boundary.holdNext = false
              boundary.held = String(event.data)
              event.stopImmediatePropagation()
            }
          })
        }
      }
    }, room.members[4]!)
    await page.goto(`/games/${room.members[4]!.roomCode}/session`)
    await expect(page.locator('.score-chip')).toHaveCount(5)
    const monitor = room.peers[room.submitters[2]!]!
    for (const index of room.submitters) await room.play(index)
    await monitor.wait('card_revealed')
    await page.evaluate(() => {
      const boundary = (
        window as unknown as {
          privacyBoundary: { socket: WebSocket; holdNext: boolean }
        }
      ).privacyBoundary
      boundary.holdNext = true
      boundary.socket.send(JSON.stringify({ type: 'rejoin' }))
    })
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const held = (window as unknown as { privacyBoundary: { held: string } })
              .privacyBoundary.held
            return held ? JSON.parse(held).state.revealIndex : null
          }),
        { intervals: [5] },
      )
      .toBe(1)
    await expect
      .poll(() => monitor.events.filter((event) => event.type === 'card_revealed').length, {
        intervals: [5],
      })
      .toBe(2)
    const pick = room.initial[0]!.prompt.pick
    await expect(page.locator('.flip-reveal .card-response')).toHaveCount(2 * pick)
    await page.evaluate(() => {
      const boundary = (
        window as unknown as {
          privacyBoundary: { socket: WebSocket; held: string }
        }
      ).privacyBoundary
      boundary.socket.dispatchEvent(new MessageEvent('message', { data: boundary.held }))
    })
    // Drain React's update before checking the known-live second answer.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    expect(await page.locator('.flip-reveal .card-response').count()).toBe(2 * pick)
    await expect(page.locator('.hidden-card')).toHaveCount(pick)
    await expect(page.locator('.flip-reveal .card-response')).toHaveCount(3 * pick)
    await expect(page.locator('.hidden-card')).toHaveCount(0)
    const revealed = monitor.events.filter((event) => event.type === 'card_revealed')
    for (const event of revealed) {
      for (const card of event.fills)
        await expect(page.locator('.subs-grid')).toContainText(card.text)
    }
    // Index IDs are reused on the next round. Replaying the old snapshot
    // must not attach its revealed answers to the new prompt.
    const after = monitor.events.length
    room.peers[room.czar]!.send({ type: 'pick', submissionId: '0' })
    expect((await monitor.wait('round_started', after)).round).toBe(2)
    await expect(page.locator('.pill').first()).toContainText('Round 2')
    await page.evaluate(() => {
      const boundary = (
        window as unknown as {
          privacyBoundary: { socket: WebSocket; held: string }
        }
      ).privacyBoundary
      boundary.socket.dispatchEvent(new MessageEvent('message', { data: boundary.held }))
    })
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    expect(await page.locator('.pill').first().textContent()).toContain('Round 2')
    expect(await page.locator('.flip-reveal .card-response').count()).toBe(0)
  } finally {
    await page.close()
    await room.close()
  }
})
