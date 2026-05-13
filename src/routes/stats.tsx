import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Topbar } from '~/components/ui/Topbar'

export const Route = createFileRoute('/stats')({
  component: StatsScreen,
})

function StatsScreen() {
  const navigate = useNavigate()
  return (
    <div className="scene">
      <Topbar
        right={
          <button className="btn btn-ghost btn-sm" onClick={() => navigate({ to: '/' })}>
            ← Back
          </button>
        }
      />
      <div className="stats-wrap fade-in">
        <div className="stats-hd">
          <div className="eyebrow">Global stats</div>
          <h1 className="stats-title">
            By the <em>numbers</em>
          </h1>
          <p className="stats-lede">
            Everything that's happened in every game of Cards Against Bhayanak, ever.
          </p>
        </div>
        <div className="stats-tiles">
          <div className="stat-tile">
            <div className="stat-label">Games played</div>
            <div className="stat-value">—</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Rounds played</div>
            <div className="stat-value">—</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Avg players/game</div>
            <div className="stat-value">—</div>
          </div>
        </div>
      </div>
    </div>
  )
}
