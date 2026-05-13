import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { FullTopbar } from '~/components/ui/Topbar'
import { PromptCard, ResponseCard } from '~/components/ui/Card'
import { captureEvent } from '~/lib/posthog-client'
import type { BlackCard, Card } from '~/lib/types'

export const Route = createFileRoute('/')({
  component: HomeScreen,
})

const SAMPLE_PROMPT: BlackCard = {
  id: 'sample-prompt',
  text: "What's the one thing that ruins every team offsite? __________.",
  pick: 1,
}

const SAMPLE_WHITE_1: Card = { id: 's1', text: 'Aggressive eye contact during karaoke.' }
const SAMPLE_WHITE_2: Card = { id: 's2', text: 'The intern who keeps saying "pivot."' }

const MARQUEE_ITEMS = [
  'Free to play',
  '·',
  'Up to 10 players',
  '·',
  '6 card packs',
  '·',
  'House rules supported',
  '·',
  'No download',
  '·',
  'Designed for chaos',
  '·',
]

function HomeScreen() {
  const navigate = useNavigate()
  return (
    <div className="scene">
      <FullTopbar />
      <div className="home-wrap fade-in">
        <div className="home-eyebrow eyebrow">
          <span>v1.0.0</span>
          <span>·</span>
          <span>4–10 players</span>
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
          Cards Against Bhayanak is an original party game where one player reads a prompt and
          everyone else submits the funniest, worst, most morally indefensible answer. Then someone
          gets a point.
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
            card={SAMPLE_PROMPT}
            size="lg"
            className="home-card home-card-1"
            style={{ '--rot': '-7deg', transform: 'rotate(-7deg)' } as React.CSSProperties}
          />
          <ResponseCard
            card={SAMPLE_WHITE_1}
            size="md"
            className="home-card home-card-2"
            style={{ '--rot': '4deg', transform: 'rotate(4deg)' } as React.CSSProperties}
          />
          <ResponseCard
            card={SAMPLE_WHITE_2}
            size="md"
            className="home-card home-card-3"
            style={{ '--rot': '-3deg', transform: 'rotate(-3deg)' } as React.CSSProperties}
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
