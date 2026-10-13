import { expect, it } from 'vitest'
import { decideNormalRound } from './normal-round'

it('a second submission wins one point plus all losing wagers, even without wager submissions', () => {
  const fills = [{ id: 'white-1', text: 'An answer' }]
  const input = {
    winnerKey: 'winner:gamble',
    submissions: {
      winner: { fills: [{ id: 'white-2', text: 'Another answer' }] },
      'winner:gamble': { fills },
      loser: { fills: [] },
    },
    players: [
      { id: 'winner', hasGambled: true },
      { id: 'loser', hasGambled: true },
      { id: 'skipped', hasGambled: true },
      { id: 'czar', hasGambled: false },
    ],
  }
  const before = structuredClone(input)
  expect(decideNormalRound(input)).toEqual({
    winnerPlayerId: 'winner',
    winningFills: fills,
    scoreAdjustments: [
      { playerId: 'loser', delta: -1 },
      { playerId: 'skipped', delta: -1 },
      { playerId: 'winner', delta: 3 },
    ],
    submitterKeys: ['winner', 'winner:gamble', 'loser'],
  })
  expect(input).toEqual(before)
})

it('a primary winner gets one point when nobody wagers', () => {
  expect(
    decideNormalRound({
      winnerKey: 'alice',
      submissions: { alice: { fills: [] }, bob: { fills: [] } },
      players: [{ id: 'alice' }, { id: 'bob' }],
    }),
  ).toEqual({
    winnerPlayerId: 'alice',
    winningFills: [],
    scoreAdjustments: [{ playerId: 'alice', delta: 1 }],
    submitterKeys: ['alice', 'bob'],
  })
})

it('an unknown submission or missing winner cannot produce a scoring plan', () => {
  expect(decideNormalRound({ winnerKey: 'absent', submissions: {}, players: [] })).toBeNull()
  expect(
    decideNormalRound({ winnerKey: 'absent', submissions: { absent: { fills: [] } }, players: [] }),
  ).toBeNull()
})
