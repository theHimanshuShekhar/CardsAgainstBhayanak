import { createFileRoute } from '@tanstack/react-router'
import { db } from '~/db'
import { gameSessions, gamePlayers, gameRounds } from '~/db/schema'
import { sql, eq, count, and, isNotNull } from 'drizzle-orm'
import type { RuleId } from '~/lib/types'

// Labels mirror create.tsx MODAL_RULES/ORTHO_RULES. Duplicated inline (not
// imported) so this API route doesn't pull the React create screen.
const RULE_LABELS: Record<RuleId, string> = {
  godmode: 'God Is Dead',
  survival: 'Survival of the Fittest',
  serious_business: 'Serious Business',
  rebooting: 'Rebooting the Universe',
  packing_heat: 'Packing Heat',
  rando: 'Rando Cardrissian',
  never_have_i_ever: 'Never Have I Ever',
  happy_ending: 'Happy Ending',
}

export const Route = createFileRoute('/api/stats')({
  server: {
    handlers: {
      GET: async () => {
        const [gamesRow] = await db
          .select({ total: count() })
          .from(gameSessions)
          .where(eq(gameSessions.status, 'ended'))

        // "Rounds judged" = rounds that resolved with a winner in games
        // that finished. game_rounds rows are inserted at round *start*
        // for every session (lobby/abandoned/voided/in-progress too), so
        // an unfiltered count(*) over-reports massively. Scope to ended
        // sessions + a persisted winner, mirroring every other aggregate
        // here.
        const [roundsRow] = await db
          .select({ total: count() })
          .from(gameRounds)
          .innerJoin(gameSessions, eq(gameSessions.id, gameRounds.sessionId))
          .where(and(eq(gameSessions.status, 'ended'), isNotNull(gameRounds.winnerPlayerId)))

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

        // Human players per ended game → distribution + average.
        const playerCountsRaw = await db.execute<{ cnt: string; sessions: string }>(sql`
          SELECT cnt, count(*) AS sessions FROM (
            SELECT gp.session_id, count(*) AS cnt
            FROM game_players gp
            JOIN game_sessions gs ON gs.id = gp.session_id
            WHERE gs.status = 'ended' AND gp.role = 'player' AND gp.is_rando = false
            GROUP BY gp.session_id
          ) t
          GROUP BY cnt
          ORDER BY cnt
        `)

        const gamesPerDayRaw = await db.execute<{ day: string; cnt: string }>(sql`
          SELECT to_char(date_trunc('day', ended_at), 'YYYY-MM-DD') AS day, count(*) AS cnt
          FROM game_sessions
          WHERE status = 'ended' AND ended_at > now() - interval '30 days'
          GROUP BY 1 ORDER BY 1
        `)

        const packAdoptionRaw = await db.execute<{ name: string; slug: string; c: string }>(sql`
          SELECT p.name AS name, p.slug AS slug, count(DISTINCT gs.id) AS c
          FROM game_sessions gs
          CROSS JOIN LATERAL jsonb_array_elements_text(gs.config->'packs') AS pid
          JOIN packs p ON p.id = pid
          WHERE gs.status = 'ended'
          GROUP BY p.name, p.slug
          ORDER BY c DESC
        `)

        const houseRulesRaw = await db.execute<{ rule: string; c: string }>(sql`
          SELECT rule AS rule, count(DISTINCT gs.id) AS c
          FROM game_sessions gs
          CROSS JOIN LATERAL jsonb_array_elements_text(gs.config->'rules') AS rule
          WHERE gs.status = 'ended'
          GROUP BY rule
          ORDER BY c DESC
        `)

        const games = Number(gamesRow?.total ?? 0)
        const randoWins = Number(randoRow?.total ?? 0)
        const pct = (c: number) => (games > 0 ? Math.round((c / games) * 100) : 0)

        const playerCounts = Array.from(playerCountsRaw).map((r) => ({
          n: Number(r.cnt),
          count: Number(r.sessions),
        }))
        const totalCountedSessions = playerCounts.reduce((a, p) => a + p.count, 0)
        const avgPlayersPerGame =
          totalCountedSessions > 0
            ? playerCounts.reduce((a, p) => a + p.n * p.count, 0) / totalCountedSessions
            : 0

        // Dense 30-day series (today inclusive) so the Sparkline has no gaps.
        const dayMap = new Map<string, number>()
        for (const r of Array.from(gamesPerDayRaw)) dayMap.set(r.day, Number(r.cnt))
        const gamesPerDay: number[] = []
        for (let i = 29; i >= 0; i--) {
          const d = new Date()
          d.setUTCDate(d.getUTCDate() - i)
          gamesPerDay.push(dayMap.get(d.toISOString().slice(0, 10)) ?? 0)
        }

        const packAdoption = Array.from(packAdoptionRaw)
          .filter(
            (r) =>
              r.slug !== 'cah-base-set' &&
              r.slug !== 'haiku-final' &&
              !/^CAH Base Set/i.test(r.name),
          )
          .map((r) => ({ name: r.name, pct: pct(Number(r.c)) }))

        const houseRulesAdoption = Array.from(houseRulesRaw).map((r) => ({
          name: RULE_LABELS[r.rule as RuleId] ?? r.rule,
          pct: pct(Number(r.c)),
        }))

        const stats = {
          totals: {
            games,
            rounds: Number(roundsRow?.total ?? 0),
            players: Number(playersRow?.total ?? 0),
          },
          randoWins,
          randoWinRate: games > 0 ? randoWins / games : 0,
          happyEndings: Number(happyRow?.total ?? 0),
          avgPlayersPerGame,
          gamesPerDay,
          playerCountDist: playerCounts,
          packAdoption,
          houseRulesAdoption,
          topCards: Array.from(topCardsRaw).map((r) => ({ text: r.text, count: Number(r.cnt) })),
        }

        return new Response(JSON.stringify(stats), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
        })
      },
    },
  },
})
