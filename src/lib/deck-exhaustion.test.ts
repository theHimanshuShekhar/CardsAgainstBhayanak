import { describe, expect, it } from 'vitest'
import { chooseDeckExhaustionWinner, decideDeckExhaustion } from './deck-exhaustion'
import type { GamePlayer } from './types'

type Candidate = Pick<GamePlayer, 'id' | 'score' | 'role' | 'status' | 'isRando'>
const player = (id: string, score: number, changes: Partial<Candidate> = {}): Candidate => ({
  id,
  score,
  role: 'player',
  status: 'active',
  isRando: false,
  ...changes,
})

describe('deck exhaustion winner policy', () => {
  it('keeps grace players eligible and resolves zero-point ties by seat order rather than input order', () => {
    expect(
      chooseDeckExhaustionWinner(
        [player('later', 0), player('earlier', 0, { status: 'grace' })],
        ['earlier', 'later'],
      ),
    ).toBe('earlier')
    expect(
      chooseDeckExhaustionWinner([player('later', 3), player('earlier', 0)], ['earlier', 'later']),
    ).toBe('later')
  })
  it('uses IDs as a deterministic fallback and returns no winner when no eligible player remains', () => {
    expect(chooseDeckExhaustionWinner([player('z', 0), player('a', 0)], [])).toBe('a')
    expect(
      chooseDeckExhaustionWinner([player('gone', 9, { status: 'dropped' })], ['gone']),
    ).toBeUndefined()
  })
  it('lets Rando win outright but gives tied humans priority, including a human missing from seat order', () => {
    const rando = player('a-rando', 2, { isRando: true })
    expect(chooseDeckExhaustionWinner([rando, player('human', 1)], ['human'])).toBe('a-rando')
    expect(chooseDeckExhaustionWinner([rando, player('human', 2)], ['human'])).toBe('human')
    expect(chooseDeckExhaustionWinner([rando, player('z-human', 2)], [])).toBe('z-human')
  })
  it('excludes dropped, queued and spectator candidates even when they have more points', () => {
    expect(
      chooseDeckExhaustionWinner(
        [
          player('dropped', 9, { status: 'dropped' }),
          player('spectator', 8, { role: 'spectator', status: 'spectator' }),
          player('queued', 7, { status: 'queued' }),
          player('remaining', 1),
        ],
        ['dropped', 'spectator', 'queued', 'remaining'],
      ),
    ).toBe('remaining')
  })
})

it('parks an exhausted deck without a terminal result when its last eligible player has left', () => {
  expect(
    decideDeckExhaustion(
      [
        player('departed-leader', 5, { status: 'dropped' }),
        player('observer', 0, { role: 'spectator', status: 'spectator' }),
      ],
      ['departed-leader'],
    ),
  ).toEqual({ status: 'paused' })
})
