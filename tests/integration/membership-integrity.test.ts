import { afterAll, expect, it } from 'vitest'
import { serve } from 'srvx'
import type { GameConfig, ServerMessage } from '../../src/lib/types'

const { db } = await import('../../src/db')
const { gameSessions, gamePlayers, gameRounds, gameMatches, packs } =
  await import('../../src/db/schema')
const { eq } = await import('drizzle-orm')
const { endGame } = await import('../../src/lib/game-engine')
const { redis } = await import('../../src/lib/redis')
const { gameWebSocketPlugin } = await import('../../src/ws/server')
const { Route: createRoute } = await import('../../src/routes/api/games/index')
const { Route: joinRoute } = await import('../../src/routes/api/games/$code/join')
const { Route: startRoute } = await import('../../src/routes/api/games/$code/start')
const { Route: leaveRoute } = await import('../../src/routes/api/games/$code/leave')
const { Route: resetRoute } = await import('../../src/routes/api/games/$code/reset')
type Handler = (input: { request: Request; params: { code: string } }) => Promise<Response>
const handlers = Object.fromEntries(
  Object.entries({
    create: createRoute,
    join: joinRoute,
    start: startRoute,
    leave: leaveRoute,
    reset: resetRoute,
  }).map(([name, route]) => [name, (route.options.server!.handlers as { POST: Handler }).POST]),
)
const server = serve({
  port: 3157,
  hostname: '127.0.0.1',
  silent: true,
  plugins: [gameWebSocketPlugin],
  fetch: (request) => {
    const match = new URL(request.url).pathname.match(
      /^\/api\/games(?:\/([^/]+)\/(join|start|leave|reset))?$/,
    )
    if (!match) return new Response(null, { status: 404 })
    return handlers[match[2] ?? 'create']!({ request, params: { code: match[1] ?? '' } })
  },
})
await server.ready()
afterAll(async () => {
  await server.close(true)
  await redis.quit()
})

type Member = { roomCode: string; playerId: string; sessionToken: string }
async function post(path: string, body: unknown, token?: string) {
  return fetch(`${server.url!.replace(/\/$/, '')}/api/games${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

it('rejects invalid results while creation, host migration and reset preserve valid outcomes', async () => {
  const [pack] = await db.select().from(packs).limit(1)
  if (!pack) throw new Error('Membership fixture requires seeded cards')
  const config: GameConfig = {
    maxPlayers: 4,
    roundsToWin: 3,
    timer: 'Off',
    packs: [pack.id],
    rules: [],
  }
  const rooms: string[] = []
  let socket: WebSocket | undefined
  try {
    const create = async (username: string) => {
      const response = await post('', { username, anonId: `issue57-${username}`, config })
      expect(response.status).toBe(201)
      const member = (await response.json()) as Member
      rooms.push(member.roomCode)
      return member
    }
    const host = await create('Host')
    const foreign = await create('OtherRoomHost')
    const members: Member[] = []
    for (const username of ['Successor', 'Third']) {
      const response = await post(`/${host.roomCode}/join`, {
        username,
        anonId: `issue57-${username}`,
        role: 'player',
      })
      expect(response.status).toBe(200)
      members.push({ ...(await response.json()), roomCode: host.roomCode })
    }
    const successor = members[0]!
    const [room] = await db.select().from(gameSessions).where(eq(gameSessions.code, host.roomCode))
    const [deleted] = await db
      .insert(gamePlayers)
      .values({ sessionId: room!.id, username: 'Deleted fixture membership', status: 'dropped' })
      .returning()
    await db.delete(gamePlayers).where(eq(gamePlayers.id, deleted!.id))

    const events: ServerMessage[] = []
    socket = new WebSocket(`${server.url!.replace(/^http/, 'ws')}/api/games/${host.roomCode}/ws`)
    socket.onmessage = (event) => events.push(JSON.parse(String(event.data)))
    await new Promise<void>((resolve) => {
      socket!.onopen = () => resolve()
    })
    socket.send(JSON.stringify({ type: 'auth', sessionToken: successor.sessionToken }))
    await expect.poll(() => events.some((event) => event.type === 'auth_ok')).toBe(true)
    expect((await post(`/${host.roomCode}/start`, {}, host.sessionToken)).status).toBe(204)
    await expect.poll(() => events.some((event) => event.type === 'round_started')).toBe(true)

    for (const invalid of [foreign.playerId, deleted!.id])
      await expect(endGame(host.roomCode, 'normal', invalid)).rejects.toThrow()
    // A failed result cannot publish game_over or change the reconnect screen.
    socket.send(JSON.stringify({ type: 'rejoin' }))
    await expect.poll(() => events.some((event) => event.type === 'state_snapshot')).toBe(true)
    expect(events.filter((event) => event.type === 'game_over')).toEqual([])
    const snapshot = events.find((event) => event.type === 'state_snapshot')!
    if (snapshot.type !== 'state_snapshot') throw new Error('Missing active snapshot')
    expect(snapshot.state.round).toBe(1)
    expect(snapshot.state.scores).toHaveLength(3)

    await endGame(host.roomCode, 'normal', successor.playerId)
    await expect
      .poll(() => events.find((event) => event.type === 'game_over'))
      .toMatchObject({ winnerId: successor.playerId })
    expect((await post(`/${host.roomCode}/leave`, {}, host.sessionToken)).status).toBe(204)
    await expect
      .poll(() => events.find((event) => event.type === 'host_changed'))
      .toMatchObject({ hostId: successor.playerId })
    expect(
      (await post(`/${host.roomCode}/reset`, { mode: 'lobby' }, successor.sessionToken)).status,
    ).toBe(204)
    const after = events.length
    socket.send(JSON.stringify({ type: 'rejoin' }))
    await expect
      .poll(() => events.slice(after).find((event) => event.type === 'lobby_snapshot'))
      .toMatchObject({ gameStatus: 'lobby' })
    const lobby = events.slice(after).find((event) => event.type === 'lobby_snapshot')!
    if (lobby.type !== 'lobby_snapshot') throw new Error('Missing lobby snapshot')
    expect(lobby.players.find((player) => player.id === successor.playerId)?.isHost).toBe(true)
  } finally {
    if (socket) {
      const closed = new Promise<void>((resolve) => {
        socket!.onclose = () => resolve()
      })
      socket.close()
      await closed
    }
    for (const code of rooms) {
      const keys = await redis.keys(`game:${code}*`)
      if (keys.length) await redis.del(...keys)
      const [room] = await db.select().from(gameSessions).where(eq(gameSessions.code, code))
      if (!room) continue
      await db
        .update(gameSessions)
        .set({ hostPlayerId: null, winnerPlayerId: null, currentMatchId: null })
        .where(eq(gameSessions.id, room.id))
      await db.delete(gameRounds).where(eq(gameRounds.sessionId, room.id))
      await db.delete(gameMatches).where(eq(gameMatches.sessionId, room.id))
      await db.delete(gamePlayers).where(eq(gamePlayers.sessionId, room.id))
      await db.delete(gameSessions).where(eq(gameSessions.id, room.id))
    }
  }
}, 20_000)
