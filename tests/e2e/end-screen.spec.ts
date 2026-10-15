import { test, expect, type Page } from '@playwright/test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../../src/db'
import { gameSessions, gamePlayers, packs } from '../../src/db/schema'
import * as state from '../../src/lib/game-state'
import * as engine from '../../src/lib/game-engine'
import { signSessionToken } from '../../src/lib/session-token'
import type {
  EndedMatchResult,
  GameOverMode,
  GamePlayer,
  ServerToClientEvent,
} from '../../src/lib/types'

// Real ended matches; storage is only an authentication fixture, never the
// source of the expected winner or scores.
async function endedRoom(code: string, mode: GameOverMode = 'normal') {
  const hostIndex = mode === 'rando_won' ? 1 : 0
  const [pack] = await db
    .select()
    .from(packs)
    .where(
      sql`(SELECT count(*) FROM white_cards WHERE pack_id = ${packs.id}) >= 100 AND (SELECT count(*) FROM black_cards WHERE pack_id = ${packs.id}) >= 3`,
    )
    .orderBy(packs.id)
    .limit(1)
  if (!pack) throw new Error('End-screen fixture requires 100 white cards and 3 black cards')
  const config = {
    maxPlayers: 4,
    roundsToWin: 5,
    timer: 'Off' as const,
    packs: [pack.id],
    rules: [],
  }
  const [room] = await db.insert(gameSessions).values({ code, config }).returning()
  const rows = await db
    .insert(gamePlayers)
    .values(
      [mode === 'rando_won' ? 'Rando Cardrissian' : 'WinnerWinner', 'RunnerUp', 'AlsoRan'].map(
        (username, i) => ({
          sessionId: room!.id,
          username,
          score: [5, 3, 1][i],
          isHost: i === hostIndex,
          isRando: mode === 'rando_won' && i === 0,
        }),
      ),
    )
    .returning()
  await db
    .update(gameSessions)
    .set({ hostPlayerId: rows[hostIndex]!.id })
    .where(eq(gameSessions.id, room!.id))
  const players: GamePlayer[] = rows.map((player) => ({
    ...player,
    joinedAt: player.joinedAt.toISOString(),
    posthogAnonId: undefined,
  }))
  await state.createGameState(code, players[hostIndex]!.id, config)
  for (const player of players) await state.addPlayer(code, player)
  await engine.startGame(code)
  await engine.startRound(code, 1)
  // A voided round still counts toward the live screen's round counter.
  await engine.voidRound(code, 'end-result fixture')
  await engine.endGame(code, mode, players[0]!.id)
  // Room memberships can change after completion. The frozen match result wins.
  for (const player of players) await state.addPlayer(code, { ...player, score: 0 })
  return {
    roomCode: code,
    playerId: players[hostIndex]!.id,
    sessionToken: await signSessionToken({ roomCode: code, playerId: players[hostIndex]!.id }),
    username: players[hostIndex]!.username,
    role: 'player',
    anonId: `end-${code}`,
  }
}

async function expectResult(page: Page) {
  await expect(page.getByRole('heading', { name: 'WinnerWinner wins' })).toBeVisible()
  await expect(page.locator('.score-chip')).toHaveCount(3)
  await expect(page.locator('.score-chip').first()).toContainText('WinnerWinner')
  for (const [username, points] of [
    ['WinnerWinner', '5 pts'],
    ['RunnerUp', '3 pts'],
    ['AlsoRan', '1 pt'],
  ]) {
    await expect(
      page.locator('.score-chip').filter({ hasText: username }).locator('.score-meta'),
    ).toHaveText(points!)
  }
  await expect(page.getByText('Decided over 2 rounds.')).toBeVisible()
}

test('fresh tab and reload recover the frozen ended match without a cached event', async ({
  page,
  context,
}) => {
  const member = await endedRoom('END480')
  await context.addInitScript(
    (session) => localStorage.setItem('cab_session', JSON.stringify(session)),
    member,
  )
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const snapshots: ServerToClientEvent[] = []
  page.on('websocket', (socket) =>
    socket.on('framereceived', (event) => snapshots.push(JSON.parse(String(event.payload)))),
  )
  await page.goto(`/games/${member.roomCode}/end`)
  await expectResult(page)
  await expect(page.getByRole('button', { name: 'Rematch', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => sessionStorage.getItem('cab_last_game_over'))).toBeNull()
  await page.reload()
  await expectResult(page)
  expect(
    snapshots.some((event) => event.type === 'lobby_snapshot' && event.gameStatus === 'ended'),
  ).toBe(true)
  expect(errors).toEqual([])
})

test('a prior match cached in the same room never replaces the rematch result', async ({
  page,
  context,
}) => {
  const member = await endedRoom('END481')
  await context.addInitScript(
    (session) => localStorage.setItem('cab_session', JSON.stringify(session)),
    member,
  )
  const results: EndedMatchResult[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => {
      const event = JSON.parse(String(frame.payload)) as ServerToClientEvent
      if (event.type === 'lobby_snapshot' && event.result) results.push(event.result)
    }),
  )
  await page.goto(`/games/${member.roomCode}/end`)
  await expectResult(page)
  const previous = results.at(-1)!
  expect(previous.matchId).toBeTruthy()
  await page.evaluate(
    (cached) => sessionStorage.setItem('cab_last_game_over', JSON.stringify(cached)),
    { code: member.roomCode, ...previous },
  )
  const resetResponse = page.waitForResponse(`**/api/games/${member.roomCode}/reset`)
  await page.getByRole('button', { name: 'Rematch', exact: true }).click()
  expect((await resetResponse).status()).toBe(204)
  await expect(page).toHaveURL(new RegExp(`/games/${member.roomCode}/session$`))
  await expect(page.locator('.pill').first()).toHaveText('Round 1')
  const players = await state.getAllPlayers(member.roomCode)
  for (const player of players)
    await state.updatePlayer(member.roomCode, player.id, {
      score: player.username === 'RunnerUp' ? 7 : 0,
    })
  await engine.endGame(
    member.roomCode,
    'normal',
    players.find((player) => player.username === 'RunnerUp')!.id,
  )
  await expect(page).toHaveURL(new RegExp(`/games/${member.roomCode}/end$`))
  await expect(page.getByRole('heading', { name: 'RunnerUp wins' })).toBeVisible()
  expect(results.at(-1)!.matchId).not.toBe(previous.matchId)

  // Delay genuine server frames to observe the initial hydrated loading state.
  // No fabricated result may appear before the current snapshot arrives.
  const pending: Array<() => void> = []
  await page.routeWebSocket(`**/api/games/${member.roomCode}/ws`, (socket) => {
    const server = socket.connectToServer()
    server.onMessage((message) => {
      if (JSON.parse(String(message)).type === 'lobby_snapshot')
        pending.push(() => socket.send(message))
      else socket.send(message)
    })
  })
  const response = await page.reload()
  expect(await response!.text()).not.toContain('WinnerWinner wins')
  await expect.poll(() => pending.length).toBeGreaterThan(0)
  await expect(page.getByRole('heading', { name: "That's a wrap" })).toBeVisible()
  await expect(page.locator('.score-chip')).toHaveCount(0)
  for (const deliver of pending) deliver()
  await expect(page.getByRole('heading', { name: 'RunnerUp wins' })).toBeVisible()
  await expect(page.locator('.score-chip').first()).toContainText('RunnerUp')
  await expect(page.locator('.score-chip').first().locator('.score-meta')).toHaveText('7 pts')
  await expect(page.getByText('Decided over 1 round.')).toBeVisible()
  expect(errors).toEqual([])
})

for (const [code, mode, heading, flourish] of [
  ['END482', 'rando_won', 'Rando Cardrissian wins', 'Everlasting shame'],
  ['END483', 'happy_ending', 'WinnerWinner wins', 'Happy ending'],
] as const) {
  test(`${mode} restores its end-screen variant from the completed match`, async ({
    page,
    context,
  }) => {
    const member = await endedRoom(code, mode)
    await context.addInitScript(
      (session) => localStorage.setItem('cab_session', JSON.stringify(session)),
      member,
    )
    await page.goto(`/games/${code}/end`)
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
    await expect(page.locator('.eyebrow')).toHaveText(flourish)
    await expect(page.locator('.score-chip')).toHaveCount(3)
  })
}

test('private ended results stay unavailable without a live room membership', async ({
  page,
  context,
  request,
}) => {
  const member = await endedRoom('END484')
  const response = await request.get(`/games/${member.roomCode}/end`)
  const html = await response.text()
  expect(html).not.toContain('WinnerWinner')
  expect(html).not.toContain('RunnerUp')
  await page.goto(`/games/${member.roomCode}/end`)
  await expect(page.getByRole('heading', { name: "That's a wrap" })).toBeVisible()
  await expect(page.locator('.score-chip')).toHaveCount(0)
  const leave = await request.post(`/api/games/${member.roomCode}/leave`, {
    headers: { Authorization: `Bearer ${member.sessionToken}` },
  })
  expect(leave.status()).toBe(204)
  await context.addInitScript((session) => {
    localStorage.setItem('cab_session', JSON.stringify(session))
    sessionStorage.setItem(
      'cab_last_game_over',
      JSON.stringify({
        code: session.roomCode,
        winnerId: session.playerId,
        finalScores: [{ playerId: session.playerId, username: 'CachedWinner', score: 999 }],
        mode: 'normal',
        totalRounds: 9,
      }),
    )
  }, member)
  const events: ServerToClientEvent[] = []
  page.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => events.push(JSON.parse(String(frame.payload)))),
  )
  await page.reload()
  await expect(page).toHaveURL('/')
  expect(
    events.some((event) => event.type === 'auth_error' && event.code === 'player_dropped'),
  ).toBe(true)
  expect(
    events.some((event) => event.type === 'lobby_snapshot' || event.type === 'state_snapshot'),
  ).toBe(false)
  expect(await page.evaluate(() => localStorage.getItem('cab_session'))).toBeNull()
})
