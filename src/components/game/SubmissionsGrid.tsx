import { ResponseCard, CardBack } from '~/components/ui/Card'
import { Avatar } from '~/components/ui/Avatar'
import type { Submission } from '~/lib/types'

type Props = {
  submissions: Submission[]
  phase: 'judging' | 'reveal'
  revealIndex: number
  winnerId: string | null
  // Winner's display handle, resolved server-side from scores. The
  // client never learns submission→playerId (privacy), so this is the
  // only place the winning player's name is available.
  winnerName: string | null
  isCzar: boolean
  onStartReveal: () => void
  onPickWinner: (submissionId: string) => void
}

export function SubmissionsGrid({
  submissions,
  phase,
  revealIndex,
  winnerId,
  winnerName,
  isCzar,
  onStartReveal,
  onPickWinner,
}: Props) {
  return (
    <div className="stage-subs">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="eyebrow">
          {phase === 'judging' && 'Awaiting judge'}
          {phase === 'reveal' && 'Reveal'}
        </div>
      </div>

      {phase === 'judging' && (
        <div className="subs-grid subs-grid-large">
          {/* filter(Boolean): a lost reveal frame must never crash every
              client via the error boundary — degrade, don't white-screen. */}
          {submissions.filter(Boolean).flatMap((s, i) =>
            s.fills.map((_, fi) => (
              <div
                key={`${i}-${fi}`}
                className={`sub-card ${s.fills.length > 1 ? 'multi-card' : ''} ${isCzar ? 'card-clickable' : ''}`}
                onClick={() => isCzar && onStartReveal()}
              >
                {s.fills.length > 1 && <div className="player-badge">{i + 1}</div>}
                <CardBack size="md" />
              </div>
            )),
          )}
          {!isCzar && <div className="judge-note">Judge is reading. Hold tight.</div>}
          {isCzar && <div className="judge-note">Click any card to start the reveal.</div>}
        </div>
      )}

      {phase === 'reveal' && (
        <div className="subs-grid subs-grid-large">
          {submissions.filter(Boolean).flatMap((s, i) => {
            const revealed = i < revealIndex
            const isWinner = s.submissionId === winnerId
            const isLoser = winnerId != null && !isWinner
            return s.fills.map((card, fi) => (
              <div
                key={`${i}-${fi}`}
                className={`sub-card ${s.fills.length > 1 ? 'multi-card' : ''} ${revealed ? '' : 'hidden-card'} ${isWinner ? 'is-winner' : ''} ${isLoser ? 'is-loser' : ''}`}
                onClick={() =>
                  isCzar && revealed && winnerId == null ? onPickWinner(s.submissionId) : undefined
                }
              >
                {s.fills.length > 1 && <div className="player-badge">{i + 1}</div>}
                {revealed ? (
                  <div className="flip-reveal">
                    <ResponseCard
                      card={card}
                      size="md"
                      onClick={
                        isCzar && winnerId == null ? () => onPickWinner(s.submissionId) : undefined
                      }
                    />
                    {isWinner && fi === 0 && (
                      <div className="winner-badge">
                        <div className="winner-by">
                          <Avatar name={winnerName ?? 'Winner'} size="sm" />
                          <span>+1 {winnerName ?? 'Winner'}</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <CardBack size="md" />
                )}
              </div>
            ))
          })}
        </div>
      )}
    </div>
  )
}
