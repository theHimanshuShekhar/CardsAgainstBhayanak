import { useEffect, useState } from 'react'
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
  // Epoch ms the round timer fires; null when timer Off. Display only —
  // the server alone skips the round (CLAUDE.md: server-controlled phase
  // timing). This countdown never sends or drives a phase change.
  roundTimerExpiresAt: number | null
}

// Display-only countdown. Re-renders once a second off the wall clock and
// reads the server's absolute expiry, so a refresh / clock skew resolves
// to the truth instead of drifting like a local "seconds left" timer.
function StageTimer({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  const remaining = Math.max(0, expiresAt - now)
  const secs = Math.ceil(remaining / 1000)
  const mm = Math.floor(secs / 60)
  const ss = secs % 60
  const urgent = remaining < 10_000

  return (
    <div className={`stage-timer${urgent ? ' stage-timer-urgent' : ''}`}>
      {mm}:{String(ss).padStart(2, '0')}
    </div>
  )
}

export function PromptStage({
  prompt,
  phase,
  czarName,
  submitted,
  expected,
  roundTimerExpiresAt,
}: Props) {
  const isWaiting = phase === 'waiting'
  const isPicking = phase === 'picking'

  return (
    <div className="stage-prompt stage-prompt-hero">
      <div className="eyebrow" style={{ marginBottom: 12 }}>
        The prompt · {czarName} is judging
      </div>

      {(isPicking || isWaiting) && roundTimerExpiresAt !== null && (
        <StageTimer expiresAt={roundTimerExpiresAt} />
      )}

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
