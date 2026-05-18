import { PromptCard } from '~/components/ui/Card'
import type { BlackCard, Submission, GamePhase } from '~/lib/types'

type Props = {
  prompt: BlackCard
  phase: GamePhase
  czarName: string
  submissions: Submission[]
}

export function PromptStage({ prompt, phase, czarName, submissions }: Props) {
  const isWaiting = phase === 'waiting'
  const isPicking = phase === 'picking'

  // filter(Boolean): a stale card_revealed landing after round_started
  // cleared submissions[] leaves a sparse hole; rendering it would crash
  // every client via the error boundary — degrade, don't white-screen.
  const present = submissions.filter(Boolean)
  const submittedCount = present.length

  return (
    <div className="stage-prompt stage-prompt-hero">
      <div className="eyebrow" style={{ marginBottom: 12 }}>
        The prompt · {czarName} is judging
      </div>
      <PromptCard card={prompt} size="xl" />

      {(isPicking || isWaiting) && (
        <>
          <div className="pick-status">
            {isPicking && (
              <span>
                {prompt.pick > 1 ? (
                  <>
                    Pick <b>{prompt.pick}</b> cards in order.
                  </>
                ) : (
                  <>Pick a card from your hand.</>
                )}
              </span>
            )}
            {isWaiting && (
              <span>
                Card submitted. Waiting on others…
                <span className="loading-dots" style={{ marginLeft: 8 }}>
                  <span />
                  <span />
                  <span />
                </span>
              </span>
            )}
          </div>
          <div className="pick-progress">
            {present.map((s, i) => (
              <div key={i} className={`pick-pip ${isWaiting ? 'on' : ''}`}>
                <span className="pick-pip-letter">
                  {(s.playerId ?? '?').slice(0, 1).toUpperCase()}
                </span>
              </div>
            ))}
            <div className="pick-progress-label muted">
              {isWaiting
                ? `${submittedCount} of ${submittedCount} submitted`
                : `0 of ${submittedCount} submitted`}
            </div>
          </div>
        </>
      )}

      {phase === 'reveal' && (
        <div
          className="muted"
          style={{ marginTop: 16, fontSize: 13, textAlign: 'center', maxWidth: 320 }}
        >
          Revealing cards…
        </div>
      )}
    </div>
  )
}
