import { describe, expect, it } from 'vitest'
import { projectSessionPhase } from './session-projection'

describe('session phase projection', () => {
  it('restores the same board and decision for modal snapshots and completed live reveals', () => {
    for (const [rule, phase, decision] of [
      ['godmode', 'waiting', 'vote'],
      ['survival', 'eliminating', 'eliminate'],
      ['serious_business', 'ranking', 'rank'],
    ] as const) {
      const common = {
        rules: [rule],
        revealIndex: 3,
        submissionCount: 3,
        finishedSubmitting: true,
        isCzar: false,
        hasWinner: false,
      }
      expect(projectSessionPhase({ ...common, phase })).toEqual({ phase: 'reveal', decision })
      expect(projectSessionPhase({ ...common, phase: 'reveal' })).toEqual({
        phase: 'reveal',
        decision,
      })
    }
  })
  it('waits for every staggered reveal and never reopens a completed decision', () => {
    const input = {
      phase: 'reveal' as const,
      rules: ['godmode' as const],
      revealIndex: 1,
      submissionCount: 4,
      finishedSubmitting: true,
      isCzar: false,
      hasWinner: false,
    }
    expect(projectSessionPhase(input)).toEqual({ phase: 'reveal', decision: null })
    expect(projectSessionPhase({ ...input, revealIndex: 4, hasWinner: true })).toEqual({
      phase: 'reveal',
      decision: null,
    })
  })
  it('keeps picking and acknowledged waiting unchanged outside decision phases', () => {
    const input = {
      phase: 'picking' as const,
      rules: [],
      revealIndex: -1,
      submissionCount: 0,
      finishedSubmitting: false,
      isCzar: false,
      hasWinner: false,
    }
    expect(projectSessionPhase(input)).toEqual({ phase: 'picking', decision: null })
    expect(projectSessionPhase({ ...input, finishedSubmitting: true })).toEqual({
      phase: 'waiting',
      decision: null,
    })
    expect(projectSessionPhase({ ...input, isCzar: true })).toEqual({
      phase: 'waiting',
      decision: null,
    })
  })
})
