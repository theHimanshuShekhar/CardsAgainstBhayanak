import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PromptCard, CardBack } from '../../src/components/ui/Card'
import { HandDock } from '../../src/components/game/HandDock'
import { SubmissionsGrid } from '../../src/components/game/SubmissionsGrid'

const markup = renderToStaticMarkup(
  createElement(
    Fragment,
    null,
    createElement(PromptCard, {
      card: { id: 'prompt', text: 'Secret prompt __________ then __________.', pick: 2 },
    }),
    createElement(PromptCard, {
      card: { id: 'filled', text: 'Secret filled prompt __________ plus __________.', pick: 2 },
      fills: ['Secret first fill.', 'Secret second fill.'],
    }),
    createElement(HandDock, {
      hand: [
        { id: 'hand-1', text: 'Secret first hand card.' },
        { id: 'hand-2', text: 'Secret second hand card.' },
      ],
      selected: ['hand-1'],
      blanks: 2,
      onToggle: () => {},
      onSubmit: () => {},
    }),
    createElement(SubmissionsGrid, {
      submissions: [
        {
          submissionId: 'submission',
          fills: [
            { id: 'submission-1', text: 'Secret first submitted card.' },
            { id: 'submission-2', text: 'Secret second submitted card.' },
          ],
        },
      ],
      phase: 'reveal',
      pickCount: 1,
      revealIndex: 1,
      winningSubmissionId: null,
      winnerName: null,
      isCzar: true,
      onStartReveal: () => {},
      onPickWinner: () => {},
    }),
    createElement(CardBack),
  ),
)

process.stdout.write(markup)
