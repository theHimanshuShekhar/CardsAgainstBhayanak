import type { Card, GamePlayer } from './types'

/** Decide a claimed normal-round outcome without storage or publication.
 * Losing wagers follow player flags, even for missing/partial submissions.
 * The adapter applies adjustments in order, then publishes/persists the result
 * and completes the round through the shared hand-refill/progression flow.
 * An unknown submission or missing winner produces no decision.
 */
export function decideNormalRound(input: {
  winnerKey: string
  submissions: Readonly<Record<string, { fills: Card[] }>>
  players: readonly Pick<GamePlayer, 'id' | 'hasGambled'>[]
}): {
  winnerPlayerId: string
  winningFills: Card[]
  scoreAdjustments: { playerId: string; delta: number }[]
  submitterKeys: string[]
} | null {
  const submission = input.submissions[input.winnerKey]
  const winnerPlayerId = input.winnerKey.endsWith(':gamble')
    ? input.winnerKey.slice(0, -7)
    : input.winnerKey
  if (!submission || !input.players.some((player) => player.id === winnerPlayerId)) return null
  const losers = input.players.filter((player) => player.hasGambled && player.id !== winnerPlayerId)
  return {
    winnerPlayerId,
    winningFills: submission.fills,
    scoreAdjustments: [
      ...losers.map((player) => ({ playerId: player.id, delta: -1 })),
      { playerId: winnerPlayerId, delta: 1 + losers.length },
    ],
    submitterKeys: Object.keys(input.submissions),
  }
}
