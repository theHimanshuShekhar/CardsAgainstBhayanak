import type { GamePhase, RuleId } from './types'

type PhaseInput = {
  phase: GamePhase
  rules: RuleId[]
  revealIndex: number
  submissionCount: number
  finishedSubmitting: boolean
  isCzar: boolean
  hasWinner: boolean
}

/** The shared view of live events and snapshots. Server phases describe the
 * room; picking/waiting also depend on this player's acknowledged submissions.
 * Decision phases all keep the revealed board visible. */
export function projectSessionPhase(input: PhaseInput): {
  phase: GamePhase
  decision: 'vote' | 'eliminate' | 'rank' | 'pick' | null
} {
  const { phase, rules, revealIndex, submissionCount, hasWinner } = input
  const complete = submissionCount > 0 && revealIndex >= submissionCount
  const board =
    phase === 'reveal' ||
    phase === 'judging' ||
    phase === 'eliminating' ||
    phase === 'ranking' ||
    (phase === 'waiting' && rules.includes('godmode') && submissionCount > 0)
  if (hasWinner) return { phase: 'reveal', decision: null }
  if (board) {
    return {
      phase: 'reveal',
      decision: !complete
        ? null
        : rules.includes('godmode')
          ? 'vote'
          : rules.includes('survival')
            ? 'eliminate'
            : rules.includes('serious_business')
              ? 'rank'
              : 'pick',
    }
  }
  return {
    phase: phase === 'picking' && (input.isCzar || input.finishedSubmitting) ? 'waiting' : phase,
    decision: null,
  }
}
