import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'

export const Route = createFileRoute('/stats')({
  component: StatsScreen,
})

type StatsResponse = {
  totals: { games: number; rounds: number; players: number }
  randoWins: number
  randoWinRate: number
  avgPlayersPerGame: number
  gamesPerDay: number[]
  playerCountDist: { n: number; count: number }[]
  packAdoption: { name: string; pct: number }[]
  houseRulesAdoption: { name: string; pct: number }[]
  topCards: { text: string; count: number }[]
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function Sparkline({ data, w = 560, h = 120 }: { data: number[]; w?: number; h?: number }) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const step = w / (data.length - 1)
  const pts = data.map((v, i): [number, number] => [
    i * step,
    h - ((v - min) / (max - min || 1)) * (h - 8) - 4,
  ])
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ')
  const area = `${path} L${w},${h} L0,${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" preserveAspectRatio="none">
      <path d={area} fill="rgba(255,255,255,0.08)" />
      <path d={path} fill="none" stroke="var(--white)" strokeWidth="2" />
      {pts.map(([x, y], i) =>
        i === pts.length - 1 ? <circle key={i} cx={x} cy={y} r="4" fill="var(--white)" /> : null,
      )}
    </svg>
  )
}

function BarChart({ data }: { data: { n: number; count: number }[] }) {
  const max = Math.max(...data.map((d) => d.count), 1)
  return (
    <div className="chart-bars">
      {data.map((d) => (
        <div className="chart-bar-row" key={d.n}>
          <div className="chart-bar-key">{d.n}</div>
          <div className="chart-bar-track">
            <div className="chart-bar-fill" style={{ width: `${(d.count / max) * 100}%` }} />
          </div>
          <div className="chart-bar-val">{d.count.toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}

function HBar({ rows }: { rows: { name: string; pct: number }[] }) {
  return (
    <div className="chart-bars">
      {rows.map((r) => (
        <div className="chart-bar-row" key={r.name}>
          <div className="chart-bar-key chart-bar-key-wide">{r.name}</div>
          <div className="chart-bar-track">
            <div className="chart-bar-fill" style={{ width: `${r.pct}%` }} />
          </div>
          <div className="chart-bar-val">{r.pct}%</div>
        </div>
      ))}
    </div>
  )
}

function StatsScreen() {
  const navigate = useNavigate()
  const [d, setD] = useState<StatsResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/stats')
      .then((r) => r.json() as Promise<StatsResponse>)
      .then((data) => {
        if (!cancelled) setD(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

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
            Everything that&apos;s happened in every game of Cards Against Bhayanak, ever.
          </p>
        </div>

        {!d ? (
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
        ) : (
          <>
            <div className="stats-tiles">
              <StatTile label="Games played" value={d.totals.games.toLocaleString()} />
              <StatTile label="Rounds judged" value={d.totals.rounds.toLocaleString()} />
              <StatTile
                label="Avg players / game"
                value={d.avgPlayersPerGame.toFixed(1)}
                sub={`${d.totals.players.toLocaleString()} players, all time`}
              />
              <StatTile
                label="Rounds / game"
                value={(d.totals.games > 0 ? d.totals.rounds / d.totals.games : 0).toFixed(1)}
              />
            </div>

            <div className="stats-card">
              <div className="stats-card-hd">
                <div>
                  <div className="stats-card-title">Games ended · last 30 days</div>
                  <div className="stats-card-sub">A nice line that goes up. Mostly.</div>
                </div>
                <div className="stats-card-num">
                  <span className="stats-card-num-val">
                    {d.gamesPerDay[d.gamesPerDay.length - 1]}
                  </span>
                  <span className="stats-card-num-sub">today</span>
                </div>
              </div>
              <Sparkline data={d.gamesPerDay} />
            </div>

            <div className="stats-row stats-row-2">
              <div className="stats-card">
                <div className="stats-card-hd">
                  <div>
                    <div className="stats-card-title">Lobbies by player count</div>
                    <div className="stats-card-sub">Where the chaos lands.</div>
                  </div>
                </div>
                {d.playerCountDist.length > 0 ? (
                  <BarChart data={d.playerCountDist} />
                ) : (
                  <p className="muted">No completed games yet.</p>
                )}
              </div>

              <div className="stats-card stats-card-rando">
                <div className="stats-card-hd">
                  <div>
                    <div className="stats-card-title">Rando Cardrissian wins</div>
                    <div className="stats-card-sub">The pre-made deck that beat your friends.</div>
                  </div>
                </div>
                <div className="rando-stat">
                  <div className="rando-stat-num">{d.randoWins}</div>
                  <div className="rando-stat-tag">games won by Rando</div>
                </div>
                <div className="rando-rate">
                  <div className="rando-rate-track">
                    <div
                      className="rando-rate-fill"
                      style={{ width: `${Math.min(100, d.randoWinRate * 100 * 8)}%` }}
                    />
                  </div>
                  <div className="rando-rate-meta">
                    <span>{(d.randoWinRate * 100).toFixed(1)}% win rate</span>
                    <span className="muted">across all games</span>
                  </div>
                </div>
                <div className="rando-quote muted">
                  &quot;If Rando wins, all players go home in a state of everlasting shame.&quot;
                </div>
              </div>
            </div>

            <div className="stats-row stats-row-2">
              <div className="stats-card">
                <div className="stats-card-hd">
                  <div>
                    <div className="stats-card-title">Pack adoption</div>
                    <div className="stats-card-sub">% of games using each pack.</div>
                  </div>
                </div>
                {d.packAdoption.length > 0 ? (
                  <HBar rows={d.packAdoption} />
                ) : (
                  <p className="muted">No completed games yet.</p>
                )}
              </div>

              <div className="stats-card">
                <div className="stats-card-hd">
                  <div>
                    <div className="stats-card-title">House rules turned on</div>
                    <div className="stats-card-sub">Mostly rule-followers. Mostly.</div>
                  </div>
                </div>
                {d.houseRulesAdoption.length > 0 ? (
                  <HBar rows={d.houseRulesAdoption} />
                ) : (
                  <p className="muted">No completed games yet.</p>
                )}
              </div>
            </div>

            {d.topCards.length > 0 && (
              <div className="stats-card">
                <div className="stats-card-hd">
                  <div>
                    <div className="stats-card-title">Most-picked response cards</div>
                    <div className="stats-card-sub">The five horsemen of cheap laughs.</div>
                  </div>
                </div>
                <div className="top-cards">
                  {d.topCards.map((c, i) => (
                    <div className="top-card-row" key={c.text}>
                      <div className="top-card-rank">{String(i + 1).padStart(2, '0')}</div>
                      <div className="top-card-text">{c.text}</div>
                      <div className="top-card-num">
                        {c.count.toLocaleString()}
                        <span className="muted"> picks</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
