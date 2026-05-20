import { test, expect } from '@playwright/test'

const BASE = process.env['CAB_E2E_BASE'] ?? 'http://localhost:3000'

// S2-5: the lobby is the reconnect hub. On mount it connects, sends
// rejoin, and the server answers a pre-game session with lobby_snapshot
// ({ players, config, gameStatus }). The screen must render the roster
// and replace the hardcoded "—" config placeholders with real values.
test('S2-5: lobby renders roster + config from lobby_snapshot', async ({ page }) => {
  const packsRes = await page.request.get(`${BASE}/api/packs`)
  const { packs } = (await packsRes.json()) as { packs: { id: string; name: string }[] }
  const basePack = packs.find((p) => /base/i.test(p.name)) ?? packs[0]
  expect(basePack, 'packs are seeded').toBeTruthy()

  const created = await page.request.post(`${BASE}/api/games`, {
    data: {
      username: 'lobbyhost',
      anonId: 'a-lobbyhost',
      config: {
        maxPlayers: 8,
        roundsToWin: 5,
        timer: '90s',
        packs: [basePack!.id],
        rules: [],
      },
    },
  })
  expect(created.ok(), 'game created').toBeTruthy()
  const { roomCode, playerId, sessionToken } = (await created.json()) as {
    roomCode: string
    playerId: string
    sessionToken: string
  }

  // Seed the session the way the join flow would, before any script runs.
  await page.addInitScript((s) => window.localStorage.setItem('cab_session', JSON.stringify(s)), {
    roomCode,
    playerId,
    sessionToken,
    username: 'lobbyhost',
    role: 'player',
    anonId: 'a-lobbyhost',
  })

  await page.goto(`/games/${roomCode}/lobby`)

  // Roster arrives via lobby_snapshot, not just incremental joins.
  await expect(page.locator('.player-name', { hasText: 'lobbyhost' })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.locator('.player-host')).toBeVisible()

  // #3: the host now edits config inline via GameConfigEditor (not the
  // read-only "—" summary). The lobby_snapshot config must seed the
  // editor's live controls with the real values.
  const rounds = page.locator('.opt-row', {
    has: page.locator('.opt-name', { hasText: 'Rounds to win' }),
  })
  await expect(rounds.locator('.stepper-val')).toContainText('5')
  const maxP = page.locator('.opt-row', {
    has: page.locator('.opt-name', { hasText: 'Max players' }),
  })
  await expect(maxP.locator('.stepper-val')).toContainText('8')
  const timer = page.locator('.opt-row', {
    has: page.locator('.opt-name', { hasText: 'Round timer' }),
  })
  await expect(timer.locator('.seg-btn.active')).toHaveText('90s')
})
