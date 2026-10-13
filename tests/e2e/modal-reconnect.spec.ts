import { requestStateSnapshot } from '../ws-snapshot'
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
    ...member,
    ws,
    events,
    send(event: ClientToServerEvent) {
      ws.send(JSON.stringify(event))
    },
    async wait<T extends ServerToClientEvent['type']>(type: T, after = 0) {
      await expect
        .poll(() => events.slice(after).find((event) => event.type === type), { timeout: 30_000 })
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

for (const mode of ['godmode', 'survival', 'serious_business'] as const) {
  test(`${mode} decision makers retain live controls after refresh and socket reconnect`, async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const game = await start([mode], 20, true, 5)
    const contexts = []
    try {
      const initial = await game.peers[0]!.snapshot()
      const actors =
        mode === 'godmode'
          ? game.peers
          : mode === 'survival'
            ? game.peers.filter((peer) => peer !== game.czar)
            : [game.czar!]
      const viewers = []
      for (const [index, actor] of actors.entries()) {
        const context = await browser.newContext({
          viewport: index % 2 === 0 ? { width: 1280, height: 720 } : { width: 390, height: 844 },
        })
        contexts.push(context)
        const page = await context.newPage()
        let snapshots = 0
        page.on('websocket', (socket) =>
          socket.on('framereceived', (frame) => {
            if (JSON.parse(String(frame.payload)).type === 'state_snapshot') snapshots++
          }),
        )
        await page.addInitScript(
          (session) => {
            localStorage.setItem('cab_session', JSON.stringify(session))
            const NativeSocket = window.WebSocket
            const sockets: WebSocket[] = []
            Object.assign(window, { cabTestSockets: sockets })
            window.WebSocket = class extends NativeSocket {
              constructor(url: string | URL, protocols?: string | string[]) {
                super(url, protocols)
                sockets.push(this)
              }
            }
          },
          {
            roomCode: actor.roomCode,
            playerId: actor.playerId,
            sessionToken: actor.sessionToken,
            username: initial.scores.find((score) => score.playerId === actor.playerId)!.username,
            role: 'player',
            anonId: `modal-${actor.playerId}`,
          },
        )
        await page.goto(`/games/${actor.roomCode}/session`)
        await expect.poll(() => snapshots).toBeGreaterThan(0)
        viewers.push({ actor, page, snapshots: () => snapshots })
      }
      await ready(game)
      let board = await game.peers[0]!.snapshot()
      if (mode === 'survival') {
        const firstActor = viewers.find(
          (viewer) => viewer.actor.playerId === board.eliminationTurnPlayerId,
        )!
        const marker = game.peers[0]!.events.length
        await firstActor.page.getByTestId('eliminate-btn').nth(0).click()
        await game.peers[0]!.wait('card_eliminated', marker)
        await game.peers[0]!.wait('elimination_turn', marker)
        board = await game.peers[0]!.snapshot()
        expect(board.eliminationTurnPlayerId).not.toBe(firstActor.actor.playerId)
      }
      for (const viewer of viewers) {
        const { actor, page } = viewer
        const controls = page.getByTestId(
          mode === 'godmode' ? 'vote-btn' : mode === 'survival' ? 'eliminate-btn' : 'rank-btn',
        )
        const ownSubmissionIds = mode === 'godmode' ? (await actor.snapshot()).mySubmissionIds : []
        const legal = mode !== 'survival' || board.eliminationTurnPlayerId === actor.playerId
        const verify = async () => {
          await expect(controls).toHaveCount(board.submissions.length)
          for (const submission of board.submissions)
            for (const card of submission.fills)
              await expect(
                page.locator('.subs-grid').getByText(card.text, { exact: true }),
              ).toBeVisible()
          if (mode === 'survival') {
            await expect(page.locator('.sub-card.is-eliminated')).toHaveCount(board.prompt.pick)
            await expect(controls.nth(0)).toHaveText('Eliminated')
          }
          for (const [index, control] of (await controls.all()).entries()) {
            const ownAnswer = ownSubmissionIds.includes(board.submissions[index]!.submissionId)
            if (ownAnswer) await expect(control).toHaveText('Your answer')
            if (legal && !ownAnswer && !(mode === 'survival' && index === 0))
              await expect(control).toBeEnabled()
            else await expect(control).toBeDisabled()
          }
        }
        await verify()
        const beforeRefresh = viewer.snapshots()
        await page.reload()
        await expect.poll(viewer.snapshots).toBeGreaterThan(beforeRefresh)
        await verify()
        const beforeReconnect = viewer.snapshots()
        await page.evaluate(() => {
          const sockets = (window as unknown as { cabTestSockets: WebSocket[] }).cabTestSockets
          sockets.forEach((socket) => socket.close())
        })
        await expect.poll(viewer.snapshots, { timeout: 15_000 }).toBeGreaterThan(beforeReconnect)
        await verify()
      }
      if (mode === 'survival') {
        // The next turn holder uses the mobile viewport. Confirm a native
        // click can reach an available action after all refreshes/rejoins.
        const nextActor = viewers.find(
          (viewer) => viewer.actor.playerId === board.eliminationTurnPlayerId,
        )!
        const marker = game.peers[0]!.events.length
        await nextActor.page.getByTestId('eliminate-btn').nth(1).click()
        await game.peers[0]!.wait('card_eliminated', marker)
        await expect(nextActor.page.locator('.sub-card.is-eliminated')).toHaveCount(
          2 * board.prompt.pick,
        )
        await expect(nextActor.page.getByTestId('eliminate-btn').nth(0)).toBeDisabled()
        await expect(nextActor.page.getByTestId('eliminate-btn').nth(1)).toBeDisabled()
      }
    } finally {
      await Promise.all(contexts.map((context) => context.close()))
      game.close()
    }
  })
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`normal judge can pick a card at ${viewport.width}px`, async ({ browser }) => {
    const game = await start()
    const context = await browser.newContext({ viewport })
    try {
      const actor = game.czar!
      const page = await context.newPage()
      await page.addInitScript(
        (session) => localStorage.setItem('cab_session', JSON.stringify(session)),
        {
          roomCode: actor.roomCode,
          playerId: actor.playerId,
          sessionToken: actor.sessionToken,
          username: 'Judge',
          role: 'player',
          anonId: `normal-judge-${viewport.width}`,
        },
      )
      await page.goto(`/games/${actor.roomCode}/session`)
      await expect(page.locator('.card-prompt')).toBeVisible()
      await ready(game)
      await page.locator('.sub-card').first().click()
      await actor.wait('round_won')
      await expect(page.locator('.winner-badge')).toBeVisible()
    } finally {
      await context.close()
      game.close()
    }
  })
}
