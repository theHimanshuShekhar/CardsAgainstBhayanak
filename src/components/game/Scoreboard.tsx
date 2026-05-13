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
        const isJudge = s.playerId === czarId || s.isJudge
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
