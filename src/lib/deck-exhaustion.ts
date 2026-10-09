import type { GamePlayer } from './types'

/** Highest score wins; tied humans follow stable seat order, then Rando.
 * IDs break a tie only for players absent from the authoritative seat order.
 */
export function chooseDeckExhaustionWinner(
  players: Pick<GamePlayer, 'id' | 'score' | 'role' | 'status' | 'isRando'>[],
  seatOrder: readonly string[],
): string | undefined {
  const seat = (id: string) => {
    const index = seatOrder.indexOf(id)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  return players
    .filter(
      (player) =>
        player.role === 'player' && (player.status === 'active' || player.status === 'grace'),
    )
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.isRando) - Number(b.isRando) ||
        seat(a.id) - seat(b.id) ||
        a.id.localeCompare(b.id),
    )[0]?.id
}
