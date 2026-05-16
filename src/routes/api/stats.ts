import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions, gamePlayers, gameRounds } from '~/db/schema'
import { sql, eq, count } from 'drizzle-orm'

export const Route = createFileRoute('/api/stats')({
  server: {
    handlers: {
      GET: async () => {
        const [gamesRow] = await db
          .select({ total: count() })
          .from(gameSessions)
          .where(eq(gameSessions.status, 'ended'))

        const [roundsRow] = await db.select({ total: count() }).from(gameRounds)

        const [randoRow] = await db
          .select({ total: count() })
          .from(gameSessions)
          .where(eq(gameSessions.endMode, 'rando_won'))

        const [happyRow] = await db
          .select({ total: count() })
          .from(gameSessions)
          .where(eq(gameSessions.endMode, 'happy_ending'))

        const [playersRow] = await db
          .select({ total: count() })
          .from(gamePlayers)
          .where(eq(gamePlayers.isRando, false))

        const topCardsRaw = await db.execute<{ text: string; cnt: string }>(sql`
      SELECT fill->>'text' AS text, count(*) AS cnt
      FROM game_rounds, jsonb_array_elements(winning_submission_fills) AS fill
      WHERE winning_submission_fills IS NOT NULL
      GROUP BY fill->>'text'
      ORDER BY cnt DESC
      LIMIT 5
    `)

        const games = Number(gamesRow?.total ?? 0)
        const randoWins = Number(randoRow?.total ?? 0)

        const stats = {
          totals: {
            games,
            rounds: Number(roundsRow?.total ?? 0),
            players: Number(playersRow?.total ?? 0),
          },
          randoWins,
          randoWinRate: games > 0 ? randoWins / games : 0,
          happyEndings: Number(happyRow?.total ?? 0),
          topCards: Array.from(topCardsRaw).map((r) => ({ text: r.text, count: Number(r.cnt) })),
        }

        return new Response(JSON.stringify(stats), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
        })
      },
    },
  },
})
