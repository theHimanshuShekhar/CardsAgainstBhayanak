// stats.jsx — analytics dashboard

const STATS_DATA = {
  totals: {
    games: 12847,
    rounds: 184329,
    submissions: 1287204,
    players: 38291,
    spectators: 16720,
  },
  averages: {
    playersPerGame: 5.2,
    spectatorsPerGame: 1.3,
    roundsPerGame: 14.4,
    sessionMin: 42,
  },
  randoWins: 287,
  randoWinRate: 0.022, // 2.2% of games
  gamesPerDay: [
    410, 432, 398, 480, 512, 498, 540, 560, 538, 582, 610, 604, 650, 672, 694, 718, 702, 740, 762,
    758, 790, 812, 830, 824, 860, 888, 910, 902, 948, 972,
  ],
  playerCountDist: [
    { n: 3, count: 642 },
    { n: 4, count: 1820 },
    { n: 5, count: 3104 },
    { n: 6, count: 2890 },
    { n: 7, count: 1740 },
    { n: 8, count: 1422 },
    { n: 9, count: 720 },
    { n: 10, count: 509 },
  ],
  packs: [
    { name: 'Core Pack', pct: 100 },
    { name: 'Bhayanak Desi', pct: 78 },
    { name: 'Office Hours', pct: 64 },
    { name: 'Extremely Online', pct: 41 },
    { name: 'Spicy (18+)', pct: 38 },
    { name: 'Festive Edition', pct: 22 },
  ],
  houseRules: [
    { name: 'Rebooting the Universe', pct: 61 },
    { name: 'Happy Ending', pct: 44 },
    { name: 'God Is Dead', pct: 31 },
    { name: 'The Comeback', pct: 27 },
    { name: 'Haiku Mode', pct: 12 },
  ],
  topCards: [
    { text: 'My therapist.', picks: 14820 },
    { text: 'Aggressive eye contact during karaoke.', picks: 12104 },
    { text: 'The third margarita.', picks: 11876 },
    { text: 'A surprisingly aggressive pigeon.', picks: 9844 },
    { text: 'Pretending to know what NFTs are.', picks: 8902 },
  ],
}

function StatTile({ label, value, sub }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function Sparkline({ data, w = 560, h = 120, fill = true }) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const step = w / (data.length - 1)
  const pts = data.map((v, i) => [i * step, h - ((v - min) / (max - min || 1)) * (h - 8) - 4])
  const path = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ')
  const area = `${path} L${w},${h} L0,${h} Z`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" preserveAspectRatio="none">
      {fill && <path d={area} fill="rgba(255,255,255,0.08)" />}
      <path d={path} fill="none" stroke="var(--white)" strokeWidth="2" />
      {pts.map(([x, y], i) =>
        i === pts.length - 1 ? <circle key={i} cx={x} cy={y} r="4" fill="var(--white)" /> : null,
      )}
    </svg>
  )
}

function BarChart({ data, keyName = 'n', valueName = 'count' }) {
  const max = Math.max(...data.map((d) => d[valueName]))
  return (
    <div className="chart-bars">
      {data.map((d, i) => (
        <div className="chart-bar-row" key={i}>
          <div className="chart-bar-key">{d[keyName]}</div>
          <div className="chart-bar-track">
            <div className="chart-bar-fill" style={{ width: `${(d[valueName] / max) * 100}%` }} />
          </div>
          <div className="chart-bar-val">{d[valueName].toLocaleString()}</div>
        </div>
      ))}
    </div>
  )
}

function HBar({ rows }) {
  return (
    <div className="chart-bars">
      {rows.map((r, i) => (
        <div className="chart-bar-row" key={i}>
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

function StatsScreen({ go }) {
  const d = STATS_DATA
  return (
    <div className="scene">
      <Topbar
        onHome={() => go('home')}
        right={
          <button className="btn btn-ghost btn-sm" onClick={() => go('home')}>
            ← Back
          </button>
        }
      />
      <div className="stats-wrap fade-in">
        <div className="stats-hd">
          <div className="eyebrow">Live · last 30 days</div>
          <h1 className="stats-title">
            The state of <em>chaos</em>.
          </h1>
          <p className="stats-lede">
            How Cards Against Bhayanak is actually being played, across every lobby, in real
            time-ish.
          </p>
        </div>

        {/* HEADLINE TILES */}
        <div className="stats-tiles">
          <StatTile label="Games played" value={d.totals.games.toLocaleString()} sub="+12% wk/wk" />
          <StatTile
            label="Rounds judged"
            value={d.totals.rounds.toLocaleString()}
            sub="14.4 avg per game"
          />
          <StatTile
            label="Cards submitted"
            value={(d.totals.submissions / 1000).toFixed(0) + 'k'}
            sub="1.28M total"
          />
          <StatTile
            label="Avg players / game"
            value={d.averages.playersPerGame.toFixed(1)}
            sub="5.2 humans, on average"
          />
          <StatTile
            label="Avg spectators"
            value={d.averages.spectatorsPerGame.toFixed(1)}
            sub="1.3 lurkers / lobby"
          />
          <StatTile
            label="Avg session"
            value={`${d.averages.sessionMin}m`}
            sub="From lobby to last card"
          />
        </div>

        {/* GAMES OVER TIME */}
        <div className="stats-card">
          <div className="stats-card-hd">
            <div>
              <div className="stats-card-title">Games started · last 30 days</div>
              <div className="stats-card-sub">A nice line that goes up. Mostly.</div>
            </div>
            <div className="stats-card-num">
              <span className="stats-card-num-val">{d.gamesPerDay[d.gamesPerDay.length - 1]}</span>
              <span className="stats-card-num-sub">today</span>
            </div>
          </div>
          <Sparkline data={d.gamesPerDay} />
        </div>

        <div className="stats-row stats-row-2">
          {/* PLAYER COUNT DIST */}
          <div className="stats-card">
            <div className="stats-card-hd">
              <div>
                <div className="stats-card-title">Lobbies by player count</div>
                <div className="stats-card-sub">Sweet spot lives at 5–6.</div>
              </div>
            </div>
            <BarChart data={d.playerCountDist} />
          </div>

          {/* RANDO CARDRISSIAN */}
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
                  style={{ width: `${d.randoWinRate * 100 * 8}%` }}
                />
              </div>
              <div className="rando-rate-meta">
                <span>{(d.randoWinRate * 100).toFixed(1)}% win rate</span>
                <span className="muted">across all games</span>
              </div>
            </div>
            <div className="rando-quote muted">
              "If Rando wins, all players go home in a state of everlasting shame."
            </div>
          </div>
        </div>

        <div className="stats-row stats-row-2">
          {/* PACKS */}
          <div className="stats-card">
            <div className="stats-card-hd">
              <div>
                <div className="stats-card-title">Pack adoption</div>
                <div className="stats-card-sub">% of games using each pack.</div>
              </div>
            </div>
            <HBar rows={d.packs} />
          </div>

          {/* HOUSE RULES */}
          <div className="stats-card">
            <div className="stats-card-hd">
              <div>
                <div className="stats-card-title">House rules turned on</div>
                <div className="stats-card-sub">Mostly rule-followers. Mostly.</div>
              </div>
            </div>
            <HBar rows={d.houseRules} />
          </div>
        </div>

        {/* TOP CARDS */}
        <div className="stats-card">
          <div className="stats-card-hd">
            <div>
              <div className="stats-card-title">Most-picked response cards</div>
              <div className="stats-card-sub">The five horsemen of cheap laughs.</div>
            </div>
          </div>
          <div className="top-cards">
            {d.topCards.map((c, i) => (
              <div className="top-card-row" key={i}>
                <div className="top-card-rank">{String(i + 1).padStart(2, '0')}</div>
                <div className="top-card-text">{c.text}</div>
                <div className="top-card-num">
                  {c.picks.toLocaleString()}
                  <span className="muted"> picks</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
