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
  // God Is Dead extras. `mode` flips judging vs voting affordances;
  // `canVote` is the parent-computed enable gate (all cards revealed,
  // no vote cast yet, no winner). `voteTally` mirrors the engine's
  // running totals per submissionId. `myVotedSubmissionId` is the
  // submission this client voted for, used to disable all buttons
  // after a tap. Defaulted so non-godmode callers can omit them.
  mode?: 'normal' | 'godmode'
  canVote?: boolean
  voteTally?: Record<string, number>
  myVotedSubmissionId?: string | null
  onVote?: (submissionId: string) => void
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
  mode = 'normal',
  canVote = false,
  voteTally = {},
  myVotedSubmissionId = null,
  onVote,
}: Props) {
  const isGodmode = mode === 'godmode'
  return (
    <div className="stage-subs">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="eyebrow">
          {phase === 'judging' && (isGodmode ? 'Voting opens after reveal' : 'Awaiting judge')}
          {phase === 'reveal' && (isGodmode ? 'Vote for the funniest' : 'Reveal')}
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
          {!isCzar && !isGodmode && <div className="judge-note">Judge is reading. Hold tight.</div>}
          {isCzar && <div className="judge-note">Click any card to start the reveal.</div>}
          {isGodmode && !isCzar && (
            <div className="judge-note">Reveal in progress. Get your votes ready.</div>
          )}
        </div>
      )}

      {phase === 'reveal' && (
        <div className="subs-grid subs-grid-large">
          {submissions.filter(Boolean).flatMap((s, i) => {
            const revealed = i < revealIndex
            const isWinner = s.submissionId === winnerId
            const isLoser = winnerId != null && !isWinner
            const votes = voteTally[s.submissionId] ?? 0
            const iVotedThis = myVotedSubmissionId === s.submissionId
            return s.fills.map((card, fi) => (
              <div
                key={`${i}-${fi}`}
                className={`sub-card ${s.fills.length > 1 ? 'multi-card' : ''} ${revealed ? '' : 'hidden-card'} ${isWinner ? 'is-winner' : ''} ${isLoser ? 'is-loser' : ''}`}
                onClick={() =>
                  !isGodmode && isCzar && revealed && winnerId == null
                    ? onPickWinner(s.submissionId)
                    : undefined
                }
              >
                {s.fills.length > 1 && <div className="player-badge">{i + 1}</div>}
                {revealed ? (
                  <div className="flip-reveal">
                    <ResponseCard
                      card={card}
                      size="md"
                      onClick={
                        !isGodmode && isCzar && winnerId == null
                          ? () => onPickWinner(s.submissionId)
                          : undefined
                      }
                    />
                    {isGodmode && fi === 0 && (
                      <div className="vote-strip">
                        <button
                          className={`btn btn-ghost btn-sm vote-btn${iVotedThis ? ' is-armed' : ''}`}
                          data-testid="vote-btn"
                          disabled={!canVote}
                          onClick={() => onVote?.(s.submissionId)}
                        >
                          {iVotedThis ? 'Voted' : 'Vote'}
                        </button>
                        <span className="vote-tally" data-testid="vote-tally">
                          {votes} {votes === 1 ? 'vote' : 'votes'}
                        </span>
                      </div>
                    )}
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
