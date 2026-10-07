import { ResponseCard, CardBack } from '~/components/ui/Card'
import { Avatar } from '~/components/ui/Avatar'
import type { Submission } from '~/lib/types'

type Props = {
  submissions: Submission[]
  pickCount: 1 | 2 | 3
  phase: 'judging' | 'reveal'
  revealIndex: number
  winnerId: string | null
  // Winner's display handle, resolved server-side from scores. The
  // client never learns submission→playerId (privacy), so this is the
  // only place the winning player's name is available.
  winnerName: string | null
  isCzar: boolean
  pending?: boolean
  onStartReveal: () => void
  onPickWinner: (submissionId: string) => void
  // God Is Dead extras. `mode` flips judging vs voting affordances;
  // `canVote` is the parent-computed enable gate (all cards revealed,
  // no vote cast yet, no winner). `voteTally` mirrors the engine's
  // running totals per submissionId. `myVotedSubmissionId` is the
  // submission this client voted for, used to disable all buttons
  // after a tap. Defaulted so non-godmode callers can omit them.
  mode?: 'normal' | 'godmode' | 'survival' | 'serious_business'
  canVote?: boolean
  mySubmissionIds?: string[]
  voteTally?: Record<string, number>
  myVotedSubmissionId?: string | null
  onVote?: (submissionId: string) => void
  // Survival of the Fittest extras. `canEliminate` is the parent-computed
  // gate (it's this client's turn AND all cards revealed AND no winner).
  // `eliminatedIds` carries the submissionIds locally flagged eliminated
  // (mirrors `submission.eliminated` but renders even before the server
  // round-resolves), and `onEliminate` fires the WS message.
  canEliminate?: boolean
  eliminatedIds?: Set<string>
  onEliminate?: (submissionId: string) => void
  // Serious Business extras. `canRank` is true when the czar should be
  // picking the top 3. `myRanking` is the ordered submissionId list this
  // client is building (length 0..3). `onRankTap` toggles a card in/out
  // of the ranking; `onConfirmRank` submits the rank message.
  canRank?: boolean
  myRanking?: string[]
  onRankTap?: (submissionId: string) => void
  onConfirmRank?: () => void
}

export function SubmissionsGrid({
  submissions,
  pickCount,
  phase,
  revealIndex,
  winnerId,
  winnerName,
  isCzar,
  pending = false,
  onStartReveal,
  onPickWinner,
  mode = 'normal',
  canVote = false,
  mySubmissionIds = [],
  voteTally = {},
  myVotedSubmissionId = null,
  onVote,
  canEliminate = false,
  eliminatedIds,
  onEliminate,
  canRank = false,
  myRanking = [],
  onRankTap,
  onConfirmRank,
}: Props) {
  const isGodmode = mode === 'godmode'
  const isSurvival = mode === 'survival'
  const isSerious = mode === 'serious_business'
  return (
    <div className="stage-subs">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="eyebrow">
          {phase === 'judging' &&
            (isGodmode
              ? 'Voting opens after reveal'
              : isSurvival
                ? 'Eliminations open after reveal'
                : isSerious
                  ? 'Ranking opens after reveal'
                  : 'Awaiting judge')}
          {phase === 'reveal' &&
            (isGodmode
              ? 'Vote for the funniest'
              : isSurvival
                ? 'Eliminate cards in turn'
                : isSerious
                  ? 'Czar ranks top 3'
                  : 'Reveal')}
        </div>
      </div>

      {phase === 'judging' && (
        <div className="subs-grid subs-grid-large">
          {/* filter(Boolean): a lost reveal frame must never crash every
              client via the error boundary — degrade, don't white-screen. */}
          {submissions.filter(Boolean).flatMap((_, i) =>
            Array.from({ length: pickCount }, (_, fi) => (
              <div
                key={`${i}-${fi}`}
                className={`sub-card ${pickCount > 1 ? 'multi-card' : ''} ${isCzar ? 'card-clickable' : ''}`}
                onClick={() => isCzar && onStartReveal()}
              >
                {pickCount > 1 && <div className="player-badge">{i + 1}</div>}
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
            const isEliminated =
              s.eliminated === true || eliminatedIds?.has(s.submissionId) === true
            // Serious Business: rank ordinal (1-based) if this submission
            // is in the czar's working ranking. 0 = unranked.
            const rankOrdinal = isSerious ? myRanking.indexOf(s.submissionId) + 1 : 0
            const clickable =
              !pending &&
              !isGodmode &&
              !isSurvival &&
              !isSerious &&
              isCzar &&
              revealed &&
              winnerId == null
            const slots = revealed ? s.fills : Array.from({ length: pickCount }, () => null)
            return slots.map((card, fi) => (
              <div
                key={`${i}-${fi}`}
                className={`sub-card ${pickCount > 1 ? 'multi-card' : ''} ${revealed ? '' : 'hidden-card'} ${isWinner ? 'is-winner' : ''} ${isLoser ? 'is-loser' : ''} ${isEliminated ? 'is-eliminated' : ''} ${rankOrdinal ? 'is-ranked' : ''}`}
                onClick={() => (clickable ? onPickWinner(s.submissionId) : undefined)}
              >
                {pickCount > 1 && <div className="player-badge">{i + 1}</div>}
                {revealed && card ? (
                  <div className="flip-reveal">
                    <ResponseCard
                      card={card}
                      size="md"
                      onClick={clickable ? () => onPickWinner(s.submissionId) : undefined}
                    />
                    {isGodmode && fi === 0 && (
                      <div className="vote-strip">
                        <button
                          className={`btn btn-ghost btn-sm vote-btn${iVotedThis ? ' is-armed' : ''}`}
                          data-testid="vote-btn"
                          disabled={pending || !canVote || mySubmissionIds.includes(s.submissionId)}
                          onClick={() => onVote?.(s.submissionId)}
                        >
                          {mySubmissionIds.includes(s.submissionId)
                            ? 'Your answer'
                            : iVotedThis
                              ? 'Voted'
                              : 'Vote'}
                        </button>
                        <span className="vote-tally" data-testid="vote-tally">
                          {votes} {votes === 1 ? 'vote' : 'votes'}
                        </span>
                      </div>
                    )}
                    {isSurvival && fi === 0 && (
                      <div className="elim-strip">
                        <button
                          className="btn btn-ghost btn-sm elim-btn"
                          data-testid="eliminate-btn"
                          disabled={!canEliminate || isEliminated || winnerId != null}
                          onClick={() => onEliminate?.(s.submissionId)}
                        >
                          {isEliminated ? 'Eliminated' : 'Eliminate'}
                        </button>
                      </div>
                    )}
                    {isSerious && fi === 0 && (
                      <div className="rank-strip">
                        <button
                          className={`btn btn-ghost btn-sm rank-btn${rankOrdinal ? ' is-armed' : ''}`}
                          data-testid="rank-btn"
                          disabled={!canRank}
                          onClick={() => onRankTap?.(s.submissionId)}
                        >
                          {rankOrdinal ? `#${rankOrdinal}` : 'Rank'}
                        </button>
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
          {isSerious && canRank && (
            <div className="rank-confirm" data-testid="rank-confirm-wrap">
              <span className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {myRanking.length}/{Math.min(3, submissions.length)} ranked
              </span>
              <button
                className="btn btn-primary btn-sm"
                data-testid="rank-confirm-btn"
                disabled={myRanking.length === 0}
                onClick={onConfirmRank}
              >
                Confirm ranking
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
