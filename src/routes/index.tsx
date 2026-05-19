import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { FullTopbar } from '~/components/ui/Topbar'
import { PromptCard, ResponseCard } from '~/components/ui/Card'
import { captureEvent } from '~/lib/posthog-client'
import type { BlackCard, Card } from '~/lib/types'

export const Route = createFileRoute('/')({
  component: HomeScreen,
})

const HOME_STACK_SETS: { prompt: BlackCard; whites: [Card, Card] }[] = [
  {
    prompt: {
      id: 'hp1',
      text: "What's the one thing that ruins every team offsite? __________.",
      pick: 1,
    },
    whites: [
      { id: 'hw1a', text: 'Aggressive eye contact during karaoke.' },
      { id: 'hw1b', text: 'The intern who keeps saying "pivot."' },
    ],
  },
  {
    prompt: { id: 'hp2', text: 'My therapist says my real problem is __________.', pick: 1 },
    whites: [
      { id: 'hw2a', text: 'A crippling addiction to group chats.' },
      { id: 'hw2b', text: 'Refusing to read the room. Ever.' },
    ],
  },
  {
    prompt: { id: 'hp3', text: 'Nothing brings a family together like __________.', pick: 1 },
    whites: [
      { id: 'hw3a', text: 'Passive-aggressive sticky notes.' },
      { id: 'hw3b', text: 'A shared, unspoken grudge.' },
    ],
  },
]

const HOME_STACK_INTERVAL_MS = 4500

const MARQUEE_ITEMS = [
  'Free to play',
  '·',
  'No sign-up',
  '·',
  '3–10 players',
  '·',
  'All 8 house rules',
  '·',
  'Real-time multiplayer',
  '·',
  'No download',
  '·',
  'Designed for chaos',
  '·',
]

function HomeScreen() {
  const navigate = useNavigate()
  const [setIdx, setSetIdx] = useState(0)
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return
    const id = setInterval(
      () => setSetIdx((i) => (i + 1) % HOME_STACK_SETS.length),
      HOME_STACK_INTERVAL_MS,
    )
    return () => clearInterval(id)
  }, [])
  const stack = HOME_STACK_SETS[setIdx]!
  return (
    <div className="scene">
      <FullTopbar />
      <div className="home-wrap fade-in">
        <div className="home-eyebrow eyebrow">
          <span>v1.0.0</span>
          <span>·</span>
          <span>3–10 players</span>
          <span>·</span>
          <span>Online</span>
        </div>
        <h1 className="home-title">
          A horrible
          <br />
          card game
          <br />
          for <em>horrible</em> friends.
        </h1>
        <p className="home-lede">
          Cards Against Bhayanak is a party game where one player reads a prompt and everyone else
          submits the funniest, worst, most morally indefensible answer. Then someone gets a point.
        </p>
        <div className="home-ctas">
          <button
            className="btn btn-primary btn-lg"
            onClick={() => {
              captureEvent('cab_create_clicked')
              void navigate({ to: '/games/create' })
            }}
          >
            Create a game
            <span style={{ opacity: 0.6 }}>→</span>
          </button>
          <button
            className="btn btn-ghost btn-lg"
            onClick={() => {
              captureEvent('cab_join_clicked')
              void navigate({ to: '/games/join' })
            }}
          >
            Join a game
          </button>
          <button
            className="btn btn-ghost btn-lg"
            onClick={() => {
              captureEvent('cab_stats_clicked')
              void navigate({ to: '/stats' })
            }}
          >
            See the stats
          </button>
        </div>
        <div className="home-stack">
          <PromptCard
            key={`p-${setIdx}`}
            card={stack.prompt}
            size="lg"
            className="home-card home-card-1 home-card-cycle"
            style={{ '--rot': '-7deg', transform: 'rotate(-7deg)' } as React.CSSProperties}
          />
          <ResponseCard
            key={`w1-${setIdx}`}
            card={stack.whites[0]}
            size="md"
            className="home-card home-card-2 home-card-cycle"
            style={
              {
                '--rot': '4deg',
                transform: 'rotate(4deg)',
                animationDelay: '90ms',
              } as React.CSSProperties
            }
          />
          <ResponseCard
            key={`w2-${setIdx}`}
            card={stack.whites[1]}
            size="md"
            className="home-card home-card-3 home-card-cycle"
            style={
              {
                '--rot': '-3deg',
                transform: 'rotate(-3deg)',
                animationDelay: '180ms',
              } as React.CSSProperties
            }
          />
        </div>
        <div className="home-marquee">
          <div className="home-marquee-track">
            {[0, 1].flatMap((k) => MARQUEE_ITEMS.map((w, i) => <span key={`${k}-${i}`}>{w}</span>))}
          </div>
        </div>
      </div>
    </div>
  )
}
