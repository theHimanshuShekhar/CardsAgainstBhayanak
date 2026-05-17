import { test, expect } from '@playwright/test'

// S2-8: the end screen renders the result of the game that just finished.
// session.tsx persists the game_over payload to sessionStorage before
// navigating here; the screen hydrates from it and shows the winner, the
// final scoreboard, and the Rando-shame / Happy-Ending variants. No live
// game is needed — seed sessionStorage the way session.tsx would.

type Score = {
  playerId: string
  username: string
  score: number
  isJudge: boolean
  isRando: boolean
}

const SCORES: Score[] = [
  { playerId: 'p1', username: 'WinnerWinner', score: 5, isJudge: false, isRando: false },
  { playerId: 'p2', username: 'RunnerUp', score: 3, isJudge: false, isRando: false },
  { playerId: 'p3', username: 'AlsoRan', score: 1, isJudge: false, isRando: false },
]

function seed(scores: Score[], winnerId: string, mode: string) {
  return JSON.stringify({ finalScores: scores, winnerId, mode, totalRounds: 9 })
}

test('S2-8: normal mode shows winner + final scoreboard', async ({ page }) => {
  await page.addInitScript(
    (v) => window.sessionStorage.setItem('cab_last_game_over', v),
    seed(SCORES, 'p1', 'normal'),
  )
  await page.goto('/games/TESTAB/end')

  await expect(page.locator('.create-title')).toContainText('WinnerWinner wins')
  await expect(page.locator('.score-chip')).toHaveCount(3)
  // Sorted by score desc → winner chip is first.
  await expect(page.locator('.score-chip').first()).toContainText('WinnerWinner')
  await expect(page.getByText('Decided over 9 rounds.')).toBeVisible()
})

test('S2-8: rando_won shows the everlasting-shame variant', async ({ page }) => {
  const randoScores: Score[] = [
    { playerId: 'r', username: 'Rando Cardrissian', score: 5, isJudge: false, isRando: true },
    ...SCORES.slice(1),
  ]
  await page.addInitScript(
    (v) => window.sessionStorage.setItem('cab_last_game_over', v),
    seed(randoScores, 'r', 'rando_won'),
  )
  await page.goto('/games/TESTAB/end')

  await expect(page.locator('.eyebrow')).toContainText('Everlasting shame')
  await expect(page.locator('.stats-lede')).toContainText('state of everlasting shame')
  await expect(page.locator('.create-title')).toContainText('Rando Cardrissian wins')
})

test('S2-8: happy_ending shows the Haiku flourish', async ({ page }) => {
  await page.addInitScript(
    (v) => window.sessionStorage.setItem('cab_last_game_over', v),
    seed(SCORES, 'p1', 'happy_ending'),
  )
  await page.goto('/games/TESTAB/end')

  await expect(page.locator('.eyebrow')).toContainText('Happy ending')
  await expect(page.getByText(/Haiku/)).toBeVisible()
})

test('S2-8: no payload falls back to the wrap stub', async ({ page }) => {
  await page.goto('/games/TESTAB/end')
  await expect(page.locator('.create-title')).toContainText("That's a wrap")
  await expect(page.locator('.score-chip')).toHaveCount(0)
})
