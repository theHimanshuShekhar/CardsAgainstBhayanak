import { Avatar } from '~/components/ui/Avatar'
import type { PlayerScore } from '~/lib/types'

type Props = {
  scores: PlayerScore[]
  czarId: string | null
}

export function Scoreboard({ scores, czarId }: Props) {
  return (
    <div className="scoreboard">
      {scores.map((s) => {
        // czarId is the single authoritative source, refreshed on every
        // round_started. PlayerScore.isJudge is baked at round_won time and
        // goes stale once the Czar rotates without a new scores payload —
        // ORing it in renders the *previous* Czar as JUDGE too. (czarId is
        // null in God Is Dead, which correctly yields no JUDGE chip.)
        const isJudge = s.playerId === czarId
        return (
          <div key={s.playerId} className={`score-chip ${isJudge ? 'is-judge' : ''}`}>
            <Avatar name={s.username} size="sm" />
            <div className="col" style={{ gap: 1 }}>
              <div className="score-name">{s.username}</div>
              <div className="score-meta">
                {isJudge ? 'JUDGE' : `${s.score} pt${s.score === 1 ? '' : 's'}`}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
