import { afterAll, expect, it } from 'vitest'
import { serve } from 'srvx'
import type { Card, PlayerScore, SessionState } from '../../src/lib/types'

const { db } = await import('../../src/db')
const { gameSessions, gamePlayers, gameRounds, packs } = await import('../../src/db/schema')
const { eq } = await import('drizzle-orm')
const engine = await import('../../src/lib/game-engine')
const state = await import('../../src/lib/game-state')
const { redis, KEYS } = await import('../../src/lib/redis')
const { Route } = await import('../../src/routes/api/stats')
process.env['SESSION_SECRET'] ??= 'issue46-integration-only-session-secret'
const { signSessionToken } = await import('../../src/lib/session-token')
const { gameWebSocketPlugin } = await import('../../src/ws/server')
const server = serve({
  port: 0,
  hostname: '127.0.0.1',
  silent: true,
  plugins: [gameWebSocketPlugin],
  fetch: () => (Route.options.server!.handlers as { GET: () => Promise<Response> }).GET(),
})
await server.ready()
const stats = async () => {
  const response = await fetch(server.url!)
  expect(response.status).toBe(200)
  return response.json() as Promise<{
    totals: { games: number; rounds: number }
    randoWins: number
    avgPlayersPerGame: number
    topCards: { text: string; count: number }[]
  }>
}
afterAll(async () => {
  await server.close(true)
  await redis.quit()
})

it('counts both completed matches after rematch and lobby replay in the same room', async () => {
  const code = 'HIS046'
  const [pack] = await db.select().from(packs).limit(1)
  const config = {
    maxPlayers: 4,
    roundsToWin: 1,
    timer: 'Off' as const,
    packs: [pack!.id],
    rules: ['rando' as const],
  }
  const [room] = await db.insert(gameSessions).values({ code, config }).returning()
  const players = await db
    .insert(gamePlayers)
    .values(
      ['Host', 'Alice', 'Bob'].map((username, i) => ({
        sessionId: room!.id,
        username,
        isHost: i === 0,
      })),
    )
    .returning()
  const subscriber = redis.duplicate()
  const events: Array<{
    type: string
    fills?: Card[]
    submissionIndex?: number
    finalScores?: PlayerScore[]
    mode?: string
    czarId?: string
    prompt?: { pick: number }
  }> = []
  subscriber.on('message', (_channel, raw) => events.push(JSON.parse(raw)))
  await subscriber.subscribe(KEYS.channel(code))
  let socket: WebSocket | undefined
  const snapshots: SessionState[] = []
  const originalPause = process.env['CAB_ROUND_RESULT_PAUSE_MS']
  process.env['CAB_ROUND_RESULT_PAUSE_MS'] = '1'
  try {
    const before = await stats()
    await state.createGameState(code, players[0]!.id, config)
    for (const player of players)
      await state.addPlayer(code, {
        ...player,
        joinedAt: player.joinedAt.toISOString(),
        posthogAnonId: undefined,
      })
    socket = new WebSocket(`${server.url!.replace(/^http/, 'ws')}/api/games/${code}/ws`)
    let authenticated = false
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.type === 'auth_ok') authenticated = true
      if (message.type === 'state_snapshot') snapshots.push(message.state)
    }
    await new Promise<void>((resolve) => {
      socket!.onopen = () => resolve()
    })
    socket.send(
      JSON.stringify({
        type: 'auth',
        sessionToken: await signSessionToken({ playerId: players[0]!.id, roomCode: code }),
      }),
    )
    await expect.poll(() => authenticated).toBe(true)
    const randoIds: string[] = []
    for (let match = 0; match < 3; match++) {
      if (match === 0) {
        await engine.startGame(code)
        await engine.startRound(code, 1)
      } else {
        await engine.resetGame(code, match === 1 ? 'rematch' : 'lobby')
        // Completed results remain counted even while the room is a lobby.
        expect((await stats()).totals.games).toBe(before.totals.games + match)
        if (match === 2) {
          await engine.startGame(code)
          await engine.startRound(code, 1)
        }
      }
      const start = events.length
      await expect
        .poll(() => events.filter((event) => event.type === 'round_started').length)
        .toBe(match + 1)
      const round = events.filter((event) => event.type === 'round_started').at(-1)!
      socket.send(JSON.stringify({ type: 'rejoin' }))
      await expect.poll(() => snapshots.length).toBe(match + 1)
      expect(snapshots.at(-1)!.round).toBe(1)
      expect(snapshots.at(-1)!.scores.every((player) => player.score === 0)).toBe(true)
      const czar = round.czarId
      const humans = new Set<string>()
      const prompt = round.prompt!
      for (const player of players.filter((player) => player.id !== czar)) {
        const cards = (await state.getHand(code, player.id)).slice(0, prompt!.pick)
        cards.forEach((id) => humans.add(id))
        await engine.submitCards(code, player.id, cards)
      }
      await expect
        .poll(() => events.slice(start).filter((event) => event.type === 'card_revealed').length)
        .toBe(3)
      const rando = events
        .slice(start)
        .find((event) => event.type === 'card_revealed' && !humans.has(event.fills![0]!.id))!
      await engine.pickWinner(code, czar!, String(rando.submissionIndex))
      await expect
        .poll(() => events.filter((event) => event.type === 'game_over').length)
        .toBe(match + 1)
      const over = events.filter((event) => event.type === 'game_over').at(-1)!
      expect(over.mode).toBe('rando_won')
      expect(over.finalScores!.filter((player) => player.isRando)).toHaveLength(1)
      const winner = over.finalScores!.find((player) => player.isRando)!
      expect(winner.score).toBe(1)
      randoIds.push(winner.playerId)
      const counted = await stats()
      expect(counted.totals.games).toBe(before.totals.games + match + 1)
      expect(counted.totals.rounds).toBe(before.totals.rounds + match + 1)
      expect(counted.randoWins).toBe(before.randoWins + match + 1)
    }
    expect(new Set(randoIds).size).toBe(3)
  } finally {
    process.env['CAB_ROUND_RESULT_PAUSE_MS'] = originalPause
    if (socket) {
      socket.close()
      await new Promise<void>((resolve) => {
        socket!.onclose = () => resolve()
      })
    }
    await subscriber.quit()
    const keys = await redis.keys(`game:${code}*`)
    if (keys.length) await redis.del(...keys)
    await db.delete(gameRounds).where(eq(gameRounds.sessionId, room!.id))
    await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, room!.id))
    await db.delete(gameSessions).where(eq(gameSessions.id, room!.id))
  }
}, 30_000)
