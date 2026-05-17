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

  // Config sheet shows the real values, not the "—" placeholder.
  const cfg = page.locator('.sheet', { hasText: 'Game config' })
  await expect(cfg.locator('.summary-row', { hasText: 'Score to win' })).toContainText('5')
  await expect(cfg.locator('.summary-row', { hasText: 'Max players' })).toContainText('8')
  await expect(cfg.locator('.summary-row', { hasText: 'Timer' })).toContainText('90s')
})
