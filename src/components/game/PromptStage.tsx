import { PromptCard } from '~/components/ui/Card'
import type { BlackCard, GamePhase } from '~/lib/types'

type Props = {
  prompt: BlackCard
  phase: GamePhase
  czarName: string
  // Server-authoritative picking progress: `submitted` of `expected`
  // players are in. Reaches submitted === expected exactly when the
  // round resolves.
  submitted: number
  expected: number
}

export function PromptStage({ prompt, phase, czarName, submitted, expected }: Props) {
  const isWaiting = phase === 'waiting'
  const isPicking = phase === 'picking'

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
            {Array.from({ length: expected }).map((_, i) => (
              <div key={i} className={`pick-pip ${i < submitted ? 'on' : ''}`} />
            ))}
            <div className="pick-progress-label muted">
              {submitted} of {expected} submitted
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
