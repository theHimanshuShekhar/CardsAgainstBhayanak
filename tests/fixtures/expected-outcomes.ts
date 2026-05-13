// Expected deterministic outcomes for games seeded with CAB_RNG_SEED=test-seed-2026
// Used in E2E tests to assert reproducible game behavior

export const SEEDED_GAME = {
  // First Czar index into the player array (seeded)
  firstCzarIndex: 0,
  // Expected winner after roundsToWin rounds
  roundsToWin: 3,
  // Max rounds before we consider the test hung
  maxRounds: 20,
} as const

export type ExpectedRoundOutcome = {
  round: number
  czarIndex: number // index into sorted player list
  winnerId?: string // set after game is run once to confirm determinism
}
