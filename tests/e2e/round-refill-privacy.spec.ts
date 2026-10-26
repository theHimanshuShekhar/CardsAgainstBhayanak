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

async function join(roomCode: string, username: string, role: 'player' | 'spectator' = 'player') {
  const response = await post(`/api/games/${roomCode}/join`, {
    username,
    anonId: `refill-${username}`,
    role,
  })
  expect(response.status).toBe(200)
  return { ...(await response.json()), roomCode } as Member
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
    member,
    send(event: ClientToServerEvent) {
      ws.send(JSON.stringify(event))
    },
    async wait<T extends ServerToClientEvent['type']>(type: T, after = 0) {
      await expect
        .poll(() => events.slice(after).find((event) => event.type === type), { timeout: 15_000 })
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

for (const mode of ['normal', 'godmode', 'survival', 'serious_business'] as const) {
  test(`${mode}: round completion delivers refills only to owners, including activated joiners, and refreshes the client hand`, async ({
    browser,
  }) => {
    test.setTimeout(60_000)
    const { packs } = (await (await fetch(BASE + '/api/packs')).json()) as {
      packs: { id: string; name: string }[]
    }
    const pack = packs.find((pack) => /base/i.test(pack.name)) ?? packs[0]!
    const response = await post('/api/games', {
      username: 'RefillHost',
      anonId: 'refill-host',
      config: {
        maxPlayers: 10,
        roundsToWin: 5,
        timer: 'Off',
        packs: [pack.id],
        rules: mode === 'normal' ? [] : [mode],
      },
    })
    expect(response.status).toBe(201)
    const host = (await response.json()) as Member
    const members = [
      host,
      await join(host.roomCode, 'Second'),
      await join(host.roomCode, 'Third'),
      await join(host.roomCode, 'Fourth'),
    ]
    const spectator = await join(host.roomCode, 'Observer', 'spectator')
    const peers = await Promise.all([...members, spectator].map(connect))
    const context = await browser.newContext()
    try {
      expect((await post(`/api/games/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(
        204,
      )
      await Promise.all(peers.map((peer) => peer.wait('round_started')))
      const snapshots = await Promise.all(peers.map((peer) => peer.snapshot()))
      expect(snapshots[members.length]!.hand).toBeUndefined()
      const czarIndex = members.findIndex((member) => member.playerId === snapshots[0]!.czarId)
      // This submitter stays a regular player after the next Czar rotation.
      const ownerIndex = members.findIndex(
        (_, index) => index !== czarIndex && index !== (czarIndex + 1) % members.length,
      )
      const owner = members[ownerIndex]!
      const page = await context.newPage()
      await page.addInitScript(
        (session) => localStorage.setItem('cab_session', JSON.stringify(session)),
        {
          ...owner,
          username: ['RefillHost', 'Second', 'Third', 'Fourth'][ownerIndex],
          role: 'player',
          anonId: 'refill-ui',
        },
      )
      await page.goto(`/games/${host.roomCode}/session`)
      await expect(page.locator('.hand-card-wrap')).toHaveCount(10)

      const queued = await join(host.roomCode, 'LatePlayer')
      const queuedPeer = await connect(queued)
      peers.push(queuedPeer)
      expect((await queuedPeer.snapshot()).hand).toBeUndefined()
      const roundStart = peers.map((peer) => peer.events.length)
      const played = new Map<string, string[]>()
      for (const [index, member] of members.entries()) {
        if (index === czarIndex) continue
        const cardIds = snapshots[index]!.hand!.slice(0, snapshots[index]!.prompt.pick).map(
          (card) => card.id,
        )
        played.set(member.playerId, cardIds)
        peers[index]!.send({ type: 'play', cardIds })
      }
      const observer = peers[members.length]!
      const phase =
        mode === 'godmode'
          ? 'waiting'
          : mode === 'survival'
            ? 'eliminating'
            : mode === 'serious_business'
              ? 'ranking'
              : 'judging'
      await expect
        .poll(async () => (await observer.snapshot()).phase, { timeout: 15_000 })
        .toBe(phase)
      if (mode === 'godmode') {
        const submissions = (await observer.snapshot()).submissions
        for (const peer of peers.slice(0, members.length)) {
          // Publicly revealed cards identify our own entry so we can avoid a self-vote.
          const ownCards = played.get(peer.member.playerId)!
          const target = submissions[0]!.fills.some((card) => ownCards.includes(card.id))
            ? '1'
            : '0'
          const after = peer.events.length
          peer.send({ type: 'vote', submissionId: target })
          await peer.wait('vote_tally', after)
        }
      } else if (mode === 'survival') {
        for (let eliminated = 0; eliminated < members.length - 2; eliminated++) {
          const turn = observer.events.filter((event) => event.type === 'elimination_turn').at(-1)!
          const actor = peers.find((peer) => peer.member.playerId === turn.playerId)!
          const after = observer.events.length
          actor.send({ type: 'eliminate', submissionId: String(eliminated) })
          await observer.wait('card_eliminated', after)
          if (eliminated < members.length - 3) await observer.wait('elimination_turn', after)
        }
      } else {
        const czar = peers[czarIndex]!
        if (mode === 'serious_business') czar.send({ type: 'rank', ranking: ['0', '1', '2'] })
        else czar.send({ type: 'pick', submissionId: '0' })
      }
      for (const [index, peer] of peers.entries()) {
        const end = await peer.wait('round_end', roundStart[index]!)
        expect(end).toEqual({ type: 'round_end', activatedPlayers: [queued.playerId] })
        await peer.wait('round_started', roundStart[index]!)
        const updates = peer.events
          .slice(roundStart[index]!)
          .filter((event) => event.type === 'hand_update')
        if (played.has(peer.member.playerId) || peer.member.playerId === queued.playerId) {
          expect(updates).toHaveLength(1)
          const update = updates[0]!
          expect(update.playerId).toBe(peer.member.playerId)
          expect(update.hand).toHaveLength(10)
          expect(update.hand.every((card) => card.text.length > 0)).toBe(true)
          for (const cardId of played.get(peer.member.playerId) ?? []) {
            expect(update.hand.map((card) => card.id)).not.toContain(cardId)
          }
          expect(peer.events.indexOf(update)).toBeLessThan(peer.events.indexOf(end))
          expect((await peer.snapshot()).hand).toEqual(update.hand)
        } else {
          expect(updates).toEqual([])
        }
        for (const event of peer.events) expect(event).not.toHaveProperty('handsRefilled')
      }
      const ownerUpdate = peers[ownerIndex]!.events.findLast(
        (event) => event.type === 'hand_update',
      )!
      await expect(page.locator('.pill', { hasText: 'Round 2' }).first()).toBeVisible()
      await expect(page.locator('.hand-card-wrap')).toHaveCount(10)
      expect(await page.locator('.hand-card-wrap .card-text').allTextContents()).toEqual(
        ownerUpdate.hand.map((card) => card.text),
      )
    } finally {
      for (const peer of peers) peer.ws.close()
      await context.close()
    }
  })
}
