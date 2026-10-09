import { test, expect } from '@playwright/test'
import {
  createGameWithRule,
  joinGame,
  getCzar,
  submitCards,
  startReveal,
  pickWinner,
  waitForPhase,
  handPickCount,
  type PlayerHandle,
} from '../helpers'

// Slice 1: Happy Ending — host triggers the forced "Make a Haiku" final.
//
// The HostMenu (⋯) only renders for the host. Clicking "End game" emits
// `happy_ending`; the engine queues the Haiku black card at the deck head
// and arms a final round. The current round still completes normally —
// the *next* round draws the Haiku prompt.

test('Happy Ending — host triggers forced Haiku final round', async ({ browser }) => {
  test.setTimeout(120_000)
  const { handle: host, roomCode } = await createGameWithRule(browser, 'Host', 'Happy Ending', {
    roundsToWin: 10,
  })
  const alice = await joinGame(browser, 'Alice', roomCode)
  const bob = await joinGame(browser, 'Bob', roomCode)

  await expect(host.page.locator('button:has-text("Start game")')).toBeEnabled({ timeout: 15_000 })
  await host.page.click('button:has-text("Start game")')

  const players: PlayerHandle[] = [host, alice, bob]
  await Promise.all(players.map((h) => h.page.waitForURL('**/session', { timeout: 20_000 })))

  // The hand-dock only mounts once round_started has been received over
  // WS — a reliable signal that auth_ok landed and the connection is
  // ready. Without this, the host can race the WS handshake on a slow
  // CI box; pre-auth sends are now queued (useGameSocket) but waiting
  // here also keeps the test's intent legible.
  await Promise.race(
    players.map((h) =>
      h.page.locator('.hand-dock, .judge-bar').first().waitFor({ timeout: 20_000 }),
    ),
  )

  // Only the host renders the HostMenu trigger.
  await expect(host.page.locator('[data-testid="host-menu"]')).toBeVisible({ timeout: 10_000 })
  await expect(alice.page.locator('[data-testid="host-menu"]')).toBeHidden()
  await expect(bob.page.locator('[data-testid="host-menu"]')).toBeHidden()

  // Open the menu and arm Happy Ending.
  await host.page.locator('[data-testid="host-menu"]').click()
  await host.page.locator('[data-testid="end-early-btn"]').click()

  // The current round must finish normally before the Haiku is drawn.
  const czar = await getCzar(players)
  const others = players.filter((p) => p !== czar)
  const pick = await handPickCount(others[0]!)
  for (const p of others) await submitCards(p, pick)
  await waitForPhase(players, 'judging')
  await startReveal(czar)
  await pickWinner(czar, 0)

  // The next round's prompt reads "Make a Haiku."
  await expect(host.page.locator('.card-prompt')).toContainText('Make a Haiku', { timeout: 30_000 })

  await Promise.all(players.map((h) => h.context.close()))
})

test('Happy Ending — trailing Haiku winner beats the cumulative leader', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000)
  const { packs } = await (await request.get('/api/packs')).json()
  const pack = packs.find((p: { name: string }) => /base/i.test(p.name))
  const response = await request.post('/api/games', {
    data: {
      username: 'Host',
      anonId: 'happy-ending-host',
      config: {
        maxPlayers: 6,
        roundsToWin: 10,
        timer: 'Off',
        packs: [pack.id],
        rules: ['happy_ending'],
      },
    },
  })
  expect(response.status()).toBe(201)
  const session = await response.json()
  const roomCode = session.roomCode as string
  const context = await browser.newContext()
  await context.addInitScript((created) => {
    localStorage.setItem(
      'cab_session',
      JSON.stringify({ ...created, username: 'Host', role: 'player', anonId: 'happy-ending-host' }),
    )
  }, session)
  const page = await context.newPage()
  await page.goto(`/games/${roomCode}/lobby`)
  const host: PlayerHandle = { context, page, roomCode, username: 'Host' }
  const players = [host]
  for (const name of ['Alice', 'Bob', 'Carol'])
    players.push(await joinGame(browser, name, roomCode))
  const gameOvers: {
    winnerId: string
    mode: string
    finalScores: { playerId: string; username: string; score: number }[]
  }[] = []
  const roundWinners: string[] = []
  host.page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const event = JSON.parse(String(payload))
      if (event.type === 'game_over') gameOvers.push(event)
      if (event.type === 'round_won') roundWinners.push(event.winningPlayerId)
    }),
  )
  // Attach before the session route opens its socket.
  await host.page.getByRole('button', { name: 'Start game' }).click()
  await Promise.all(players.map((p) => p.page.waitForURL('**/session')))
  const wins = new Map(players.map((p) => [p, 0]))
  let leader: PlayerHandle | undefined
  let finalWinner: PlayerHandle | undefined
  try {
    for (let round = 1; round <= 4; round++) {
      await expect(host.page.locator('.pill').first()).toContainText(`Round ${round}`, {
        timeout: 30_000,
      })
      const czar = await getCzar(players)
      const submitters = players.filter((p) => p !== czar)
      leader ??= submitters[0]!
      const chosen =
        round === 4
          ? submitters.find((p) => wins.get(p) === 0)!
          : submitters.includes(leader)
            ? leader
            : submitters.find((p) => p !== leader)!
      if (round === 3) {
        await host.page.getByTestId('host-menu').click()
        await host.page.getByTestId('end-early-btn').click()
      }
      if (round === 4) {
        finalWinner = chosen
        await expect(host.page.locator('.card-prompt')).toContainText('Make a Haiku')
        expect(wins.get(leader)).toBe(2)
        expect(wins.get(chosen)).toBe(0)
      }
      const chosenCard = await chosen.page.locator('.hand-card-wrap .card-text').first().innerText()
      const count = await handPickCount(submitters[0]!)
      for (const p of submitters) await submitCards(p, count)
      await waitForPhase(players, 'judging')
      await startReveal(czar)
      await expect(czar.page.locator('.flip-reveal')).toHaveCount(count * submitters.length)
      await czar.page
        .locator('.flip-reveal')
        .filter({ hasText: chosenCard })
        .first()
        .locator('.card-response')
        .first()
        .click()
      wins.set(chosen, wins.get(chosen)! + 1)
    }
    await Promise.all(players.map((p) => p.page.waitForURL('**/end', { timeout: 30_000 })))
    expect(gameOvers).toHaveLength(1)
    const result = gameOvers[0]!
    expect(result.mode).toBe('happy_ending')
    const winningScore = result.finalScores.find((p) => p.username === finalWinner!.username)!
    expect(winningScore.score).toBe(1)
    expect(result.finalScores.find((p) => p.username === leader!.username)!.score).toBe(2)
    expect(roundWinners).toHaveLength(4)
    expect(result.winnerId).toBe(roundWinners[3])
    expect(result.winnerId).toBe(winningScore.playerId)
    for (const p of players) {
      await expect(
        p.page.getByRole('heading', { name: `${finalWinner!.username} wins`, exact: true }),
      ).toBeVisible()
    }
  } finally {
    await Promise.all(players.map((p) => p.context.close()))
  }
})
