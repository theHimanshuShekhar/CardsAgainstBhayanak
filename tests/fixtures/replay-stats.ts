import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

// Provision an ended game in the real test DB. Assertions stay at the Stats
// endpoint/DOM seam; SQL is only fixture setup and cleanup.
export async function seedReplayStats() {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) throw new Error('DATABASE_URL required for replay privacy test')
  const db = postgres(databaseUrl)
  const id = randomUUID()
  const packId = `replay-pack-${id}`
  const promptId = `replay-prompt-${id}`
  const sessionId = `replay-session-${id}`
  const playerId = `replay-player-${id}`
  const cards = [
    { id: `replay-white-one-${id}`, text: `Secret statistics response one ${id}.` },
    { id: `replay-white-two-${id}`, text: `Secret statistics response two ${id}.` },
  ]

  try {
    const topCards = await db.begin(async (tx) => {
      // Outrank existing suite data without deleting or changing other games.
      const [previous] = await tx<{ max: number }[]>`
        SELECT coalesce(max(picks), 0)::int AS max FROM (
          SELECT count(*) AS picks FROM game_rounds,
            jsonb_array_elements(winning_submission_fills) AS fill
          WHERE winning_submission_fills IS NOT NULL
          GROUP BY fill->>'text'
        ) counts
      `
      const rounds = Number(previous?.max ?? 0) + 11
      const topCards = cards.map((card, i) => ({ text: card.text, count: rounds - i }))

      await tx`INSERT INTO packs (id, name, slug, card_count)
        VALUES (${packId}, 'Replay privacy fixture', ${packId}, 3)`
      await tx`INSERT INTO black_cards (id, pack_id, text, pick)
        VALUES (${promptId}, ${packId}, 'Secret statistics prompt __________.', 2)`
      await tx`INSERT INTO white_cards ${tx(cards.map((card) => ({ ...card, pack_id: packId })))}`
      await tx`INSERT INTO game_sessions (id, code, status, config, winner_player_id, end_mode, ended_at)
        VALUES (${sessionId}, ${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}, 'ended',
          ${tx.json({ maxPlayers: 3, roundsToWin: 20, timer: 'Off', packs: [packId], rules: [] })},
          ${playerId}, 'normal', now())`
      await tx`INSERT INTO game_players (id, session_id, username, is_host, score)
        VALUES (${playerId}, ${sessionId}, 'Replay fixture winner', true, ${rounds})`
      await tx`INSERT INTO game_rounds ${tx(
        Array.from({ length: rounds }, (_, i) => ({
          id: `replay-round-${id}-${i}`,
          session_id: sessionId,
          round_num: i + 1,
          black_card_id: promptId,
          winner_player_id: playerId,
          winning_submission_fills: tx.json(i === rounds - 1 ? [cards[0]!] : cards),
        })),
      )}`
      return topCards
    })

    return {
      topCards,
      async cleanup() {
        const cleanupDb = postgres(databaseUrl)
        try {
          await cleanupDb.begin(async (tx) => {
            await tx`DELETE FROM game_rounds WHERE session_id = ${sessionId}`
            await tx`DELETE FROM game_players WHERE session_id = ${sessionId}`
            await tx`DELETE FROM game_sessions WHERE id = ${sessionId}`
            await tx`DELETE FROM black_cards WHERE pack_id = ${packId}`
            await tx`DELETE FROM white_cards WHERE pack_id = ${packId}`
            await tx`DELETE FROM packs WHERE id = ${packId}`
          })
        } finally {
          await cleanupDb.end()
        }
      },
    }
  } finally {
    await db.end()
  }
}
