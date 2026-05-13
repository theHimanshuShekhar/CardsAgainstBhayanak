// screens.jsx — the four screens

const { useState, useEffect, useMemo, useRef } = React

// ─── Shared bits ──────────────────────────────────────────────

function BrandLogo({ onClick }) {
  return (
    <button className="brand" onClick={onClick}>
      <span className="brand-name">
        <span className="brand-name-full">Cards Against Bhayanak</span>
        <span className="brand-name-short">CAB</span>
      </span>
    </button>
  )
}

// Floating action rail — used by screens that need contextual controls
// (Back, Leave, status pills). Renders only `right` content; no brand,
// no tagline. Renders nothing if `right` is empty.
function Topbar({ onHome, right }) {
  if (!right) return null
  return (
    <div className="topbar topbar-minimal">
      <div className="topbar-right">{right}</div>
    </div>
  )
}

function Avatar({ name, size = 'md', you = false }) {
  const cls = size === 'lg' ? 'avatar avatar-lg' : size === 'sm' ? 'avatar avatar-sm' : 'avatar'
  const initial = (name || '?').slice(0, 1).toUpperCase()
  return (
    <div
      className={cls}
      style={
        you
          ? { background: 'var(--white)', color: 'var(--black)', borderColor: 'var(--white)' }
          : null
      }
      title={name}
    >
      {initial}
    </div>
  )
}

// renders a prompt card text with __blank__ markers
function PromptText({ text, fills }) {
  // split on __..__ (greedy blank markers) — fall back to ___ runs
  let parts
  if (text.includes('__________')) {
    parts = text.split(/(__________)/g)
  } else {
    parts = [text]
  }
  let blankIdx = 0
  return (
    <p className="card-text">
      {parts.map((p, i) => {
        if (p === '__________') {
          const fill = fills && fills[blankIdx]
          blankIdx++
          return (
            <u key={i}>
              {fill ? fill.replace(/\.$/, '') : '\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0'}
            </u>
          )
        }
        return <React.Fragment key={i}>{p}</React.Fragment>
      })}
    </p>
  )
}

function CardFoot({ variant }) {
  return null
}

function PromptCard({ text, fills, size = 'lg', className = '', style }) {
  return (
    <div className={`card card-prompt card-${size} ${className}`} style={style}>
      <PromptText text={text} fills={fills} />
      <CardFoot variant="prompt" />
    </div>
  )
}

function ResponseCard({ text, size = 'md', className = '', style, onClick, selected }) {
  return (
    <div
      className={`card card-response card-${size} ${onClick ? 'card-clickable' : ''} ${selected ? 'card-selected' : ''} ${className}`}
      style={style}
      onClick={onClick}
    >
      <p className="card-text">{text}</p>
      <CardFoot variant="response" />
    </div>
  )
}

function CardBack({ size = 'sm', style, className = '' }) {
  return (
    <div className={`card card-prompt card-back card-${size} ${className}`} style={style}>
      <div className="card-back-mark">
        <span className="card-back-full">CardsAgainstBhayanak</span>
        <span className="card-back-short">CAB</span>
      </div>
    </div>
  )
}

// ─── 1. HOME ────────────────────────────────────────────────

function HomeScreen({ go }) {
  return (
    <div className="scene">
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
          <button className="btn btn-primary btn-lg" onClick={() => go('create')}>
            Create a game
            <span style={{ opacity: 0.6 }}>→</span>
          </button>
          <button className="btn btn-ghost btn-lg" onClick={() => go('join')}>
            Join a game
          </button>
          <button className="btn btn-ghost btn-lg" onClick={() => go('stats')}>
            See the stats
          </button>
        </div>

        <div className="home-stack">
          <PromptCard
            size="lg"
            text="What's the one thing that ruins every team offsite? __________."
            className="home-card home-card-1"
            style={{ '--rot': '-7deg', transform: 'rotate(-7deg)' }}
          />
          <ResponseCard
            size="md"
            text="Aggressive eye contact during karaoke."
            className="home-card home-card-2"
            style={{ '--rot': '4deg', transform: 'rotate(4deg)' }}
          />
          <ResponseCard
            size="md"
            text="The intern who keeps saying &ldquo;pivot.&rdquo;"
            className="home-card home-card-3"
            style={{ '--rot': '-3deg', transform: 'rotate(-3deg)' }}
          />
        </div>

        <div className="home-marquee">
          <div className="home-marquee-track">
            {Array.from({ length: 2 }).flatMap((_, k) =>
              [
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
              ].map((w, i) => <span key={`${k}-${i}`}>{w}</span>),
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 2. CREATE GAME ───────────────────────────────────────────

function CreateScreen({ go, draft, setDraft }) {
  const [tab, setTab] = useState('setup')

  const togglePack = (id) => {
    setDraft((d) => ({
      ...d,
      packs: d.packs.includes(id) ? d.packs.filter((p) => p !== id) : [...d.packs, id],
    }))
  }
  const toggleRule = (id) => {
    setDraft((d) => ({
      ...d,
      rules: d.rules.includes(id) ? d.rules.filter((r) => r !== id) : [...d.rules, id],
    }))
  }

  const cardCount = window.CARD_PACKS.filter((p) => draft.packs.includes(p.id)).reduce(
    (s, p) => s + p.count,
    0,
  )

  const canStart = draft.username.trim().length >= 2

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
      <div className="create-wrap fade-in">
        <div className="create-hd">
          <div className="eyebrow">Step 1 of 2 · Setup</div>
          <h1 className="create-title">Create a game</h1>
          <p className="create-sub">
            Set your handle, pick your packs, and turn on the house rules you can live with.
          </p>
        </div>

        <div className="create-grid">
          {/* LEFT — main config */}
          <div className="create-col">
            <div className="sheet">
              <div className="sheet-hd">
                <div>
                  <div className="sheet-title">Your handle</div>
                  <div className="sheet-sub">
                    This is how everyone in the lobby will see you. Keep it short.
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 14 }}>
                <Avatar name={draft.username || '?'} size="lg" you />
                <input
                  className="input grow"
                  placeholder="e.g. priya_was_here"
                  value={draft.username}
                  maxLength={20}
                  onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
                />
              </div>
            </div>

            <div className="sheet">
              <div className="sheet-hd">
                <div>
                  <div className="sheet-title">Game options</div>
                  <div className="sheet-sub">
                    You can change these any time before the game starts.
                  </div>
                </div>
              </div>
              <div className="opt-grid">
                <div className="opt-row">
                  <div>
                    <div className="opt-name">Max players</div>
                    <div className="opt-desc">The lobby will hold this many before locking.</div>
                  </div>
                  <div className="stepper">
                    <button
                      className="stepper-btn"
                      disabled={draft.maxPlayers <= 3}
                      onClick={() => setDraft((d) => ({ ...d, maxPlayers: d.maxPlayers - 1 }))}
                    >
                      −
                    </button>
                    <div className="stepper-val">{draft.maxPlayers}</div>
                    <button
                      className="stepper-btn"
                      disabled={draft.maxPlayers >= 10}
                      onClick={() => setDraft((d) => ({ ...d, maxPlayers: d.maxPlayers + 1 }))}
                    >
                      +
                    </button>
                  </div>
                </div>
                <hr className="hr" />
                <div className="opt-row">
                  <div>
                    <div className="opt-name">Rounds to win</div>
                    <div className="opt-desc">First player to this many points wins.</div>
                  </div>
                  <div className="stepper">
                    <button
                      className="stepper-btn"
                      disabled={draft.roundsToWin <= 3}
                      onClick={() => setDraft((d) => ({ ...d, roundsToWin: d.roundsToWin - 1 }))}
                    >
                      −
                    </button>
                    <div className="stepper-val">{draft.roundsToWin}</div>
                    <button
                      className="stepper-btn"
                      disabled={draft.roundsToWin >= 20}
                      onClick={() => setDraft((d) => ({ ...d, roundsToWin: d.roundsToWin + 1 }))}
                    >
                      +
                    </button>
                  </div>
                </div>
                <hr className="hr" />
                <div className="opt-row">
                  <div>
                    <div className="opt-name">Round timer</div>
                    <div className="opt-desc">How long players have to play their card.</div>
                  </div>
                  <div className="seg">
                    {['30s', '60s', '90s', 'Off'].map((t) => (
                      <button
                        key={t}
                        className={`seg-btn ${draft.timer === t ? 'active' : ''}`}
                        onClick={() => setDraft((d) => ({ ...d, timer: t }))}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="sheet">
              <div className="sheet-hd">
                <div>
                  <div className="sheet-title">Card packs</div>
                  <div className="sheet-sub">
                    Mix and match. The dealer pulls from every active pack.
                  </div>
                </div>
                <div className="pill">
                  <span className="dot" />
                  {cardCount.toLocaleString()} cards
                </div>
              </div>
              <div className="pack-grid">
                {window.CARD_PACKS.map((p) => {
                  const on = draft.packs.includes(p.id)
                  return (
                    <div
                      key={p.id}
                      className={`check-card ${on ? 'on' : ''}`}
                      onClick={() => !p.locked && togglePack(p.id)}
                      style={p.locked ? { opacity: 0.85, cursor: 'default' } : null}
                    >
                      <div className="check-box" />
                      <div className="grow">
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <div className="check-card-title">{p.name}</div>
                          <div className="mono" style={{ fontSize: 11, color: 'var(--gray-3)' }}>
                            {p.count} {p.locked && '· LOCKED IN'}
                          </div>
                        </div>
                        <div className="check-card-desc">{p.desc}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="sheet">
              <div className="sheet-hd">
                <div>
                  <div className="sheet-title">House rules</div>
                  <div className="sheet-sub">
                    Optional. Toggle on the ones your group has actually agreed to.
                  </div>
                </div>
              </div>
              <div className="rule-grid">
                {window.HOUSE_RULES.map((r) => {
                  const on = draft.rules.includes(r.id)
                  return (
                    <div
                      key={r.id}
                      className={`check-card ${on ? 'on' : ''}`}
                      onClick={() => toggleRule(r.id)}
                    >
                      <div className="check-box" />
                      <div className="grow">
                        <div className="check-card-title">{r.name}</div>
                        <div className="check-card-desc">{r.desc}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {/* RIGHT — sticky summary */}
          <aside className="create-aside">
            <div className="sheet" style={{ position: 'sticky', top: 20 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Summary
              </div>
              <div className="summary-row">
                <span>Host</span>
                <b>{draft.username || '—'}</b>
              </div>
              <div className="summary-row">
                <span>Players</span>
                <b>{draft.maxPlayers}</b>
              </div>
              <div className="summary-row">
                <span>Score to win</span>
                <b>{draft.roundsToWin}</b>
              </div>
              <div className="summary-row">
                <span>Round timer</span>
                <b>{draft.timer}</b>
              </div>
              <div className="summary-row">
                <span>Packs</span>
                <b>{draft.packs.length}</b>
              </div>
              <div className="summary-row">
                <span>House rules</span>
                <b>{draft.rules.length}</b>
              </div>
              <div className="summary-row">
                <span>Card pool</span>
                <b>{cardCount.toLocaleString()}</b>
              </div>
              <hr className="hr" style={{ margin: '16px 0' }} />
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={!canStart}
                onClick={() => go('lobby')}
              >
                Create lobby
              </button>
              <button
                className="btn btn-ghost btn-block btn-sm"
                onClick={() => go('home')}
                style={{ marginTop: 8 }}
              >
                Cancel
              </button>
              {!canStart && (
                <div className="muted" style={{ fontSize: 11, marginTop: 12, textAlign: 'center' }}>
                  Pick a handle (2+ characters) to continue.
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

// ─── 3. LOBBY ────────────────────────────────────────────────

function LobbyScreen({ go, draft, isHost, asSpectator = false, roomFull = false }) {
  const [copied, setCopied] = useState(false)
  const startingPlayers = roomFull
    ? [
        ...window.LOBBY_PLAYERS,
        { name: 'Aanya', avatar: 'A', host: false, ready: true, you: false },
      ].slice(0, draft.maxPlayers)
    : window.LOBBY_PLAYERS
  const [players, setPlayers] = useState(startingPlayers)
  const [spectators, setSpectators] = useState(
    asSpectator
      ? [{ name: 'You', avatar: 'Y', you: true }, ...window.LOBBY_SPECTATORS]
      : window.LOBBY_SPECTATORS,
  )
  const roomCode = 'B7K-9MV'

  // simulate someone joining
  useEffect(() => {
    if (roomFull) return
    const t = setTimeout(() => {
      setPlayers((p) =>
        p.length < draft.maxPlayers
          ? [...p, { name: 'Aanya', avatar: 'A', host: false, ready: false, you: false }]
          : p,
      )
    }, 4500)
    return () => clearTimeout(t)
  }, [roomFull, draft.maxPlayers])

  const copyCode = () => {
    navigator.clipboard?.writeText(roomCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }

  const cardCount = window.CARD_PACKS.filter((p) => draft.packs.includes(p.id)).reduce(
    (s, p) => s + p.count,
    0,
  )
  const packNames = window.CARD_PACKS.filter((p) => draft.packs.includes(p.id)).map((p) => p.name)

  const empties = Math.max(0, draft.maxPlayers - players.length)

  return (
    <div className="scene">
      <Topbar
        onHome={() => go('home')}
        right={
          <>
            <div className="pill">
              <span className="dot live" />
              LIVE LOBBY
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('home')}>
              Leave
            </button>
          </>
        }
      />
      <div className="lobby-wrap fade-in">
        <div className="lobby-hd">
          <div>
            <div className="eyebrow">
              {asSpectator ? 'Lobby · Joined as spectator' : 'Lobby · Waiting for players'}
            </div>
            <h1 className="lobby-title">
              {asSpectator ? (
                <>
                  You're in.
                  <br />
                  The host hasn't started yet.
                </>
              ) : (
                <>
                  Share the code.
                  <br />
                  Wait for your worst friends.
                </>
              )}
            </h1>
          </div>
          <div className="lobby-code-card">
            <div className="eyebrow">Room code</div>
            <div className="lobby-code">{roomCode}</div>
            <div className="lobby-code-actions">
              <button className="btn btn-dark btn-sm" onClick={copyCode}>
                {copied ? '✓ Copied' : 'Copy code'}
              </button>
              <button className="btn btn-ghost btn-sm">Copy link</button>
            </div>
          </div>
        </div>

        <div className="lobby-grid">
          {/* LEFT — player list */}
          <div className="sheet">
            <div className="sheet-hd">
              <div>
                <div className="sheet-title">Players</div>
                <div className="sheet-sub">
                  {players.length} of {draft.maxPlayers} joined
                  {players.length >= draft.maxPlayers
                    ? ' · seats full'
                    : ' · need at least 3 to start'}
                </div>
              </div>
              <div className="pill">
                <span className="dot" />
                {players.length >= draft.maxPlayers
                  ? 'FULL'
                  : `${players.filter((p) => p.ready).length} READY`}
              </div>
            </div>

            <div className="player-list">
              {players.map((p, i) => (
                <div key={i} className="player-row deal" style={{ animationDelay: `${i * 0.05}s` }}>
                  <Avatar name={p.name} size="lg" you={p.you} />
                  <div className="grow">
                    <div className="player-name">
                      {p.name === 'You' ? draft.username || 'You' : p.name}
                      {p.you && <span className="player-you">YOU</span>}
                      {p.host && <span className="player-host">HOST</span>}
                    </div>
                    <div className="player-meta">{p.ready ? 'Ready' : 'Choosing a card back…'}</div>
                  </div>
                  {p.ready ? <span className="ready-dot" /> : <span className="ready-dot off" />}
                </div>
              ))}
              {Array.from({ length: empties }).map((_, i) => (
                <div key={`e${i}`} className="player-row player-row-empty">
                  <div
                    className="avatar avatar-lg"
                    style={{
                      background: 'transparent',
                      border: '1px dashed var(--hairline-2)',
                      color: 'var(--gray-4)',
                    }}
                  >
                    ?
                  </div>
                  <div className="grow">
                    <div className="player-name muted">Empty seat</div>
                    <div className="player-meta">Send them the code →</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Spectators */}
            <div className="spectator-block">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
                <div className="eyebrow">Spectators · {spectators.length} watching</div>
                {players.length >= draft.maxPlayers && !asSpectator && (
                  <div className="muted" style={{ fontSize: 11 }}>
                    Seats are full — new joiners auto-spectate.
                  </div>
                )}
              </div>
              <div className="spectator-row">
                {spectators.map((s, i) => (
                  <div key={i} className={`spectator-chip ${s.you ? 'you' : ''}`}>
                    <Avatar name={s.name} size="sm" you={s.you} />
                    <span>{s.name === 'You' ? draft.username || 'You' : s.name}</span>
                    {s.you && <span className="player-you">YOU</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* RIGHT — game info */}
          <div className="col" style={{ gap: 16 }}>
            <div className="sheet">
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Game
              </div>
              <div className="summary-row">
                <span>Host</span>
                <b>{players[0]?.name}</b>
              </div>
              <div className="summary-row">
                <span>Score to win</span>
                <b>{draft.roundsToWin} points</b>
              </div>
              <div className="summary-row">
                <span>Round timer</span>
                <b>{draft.timer}</b>
              </div>
              <div className="summary-row">
                <span>Room access</span>
                <b>Code only</b>
              </div>
            </div>

            <div className="sheet">
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Active packs · {cardCount.toLocaleString()} cards
              </div>
              <div className="col" style={{ gap: 8 }}>
                {packNames.map((n) => (
                  <div key={n} className="pack-chip">
                    <div className="pack-chip-mark" />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
            </div>

            {draft.rules.length > 0 && (
              <div className="sheet">
                <div className="eyebrow" style={{ marginBottom: 10 }}>
                  House rules
                </div>
                <div className="col" style={{ gap: 8 }}>
                  {window.HOUSE_RULES.filter((r) => draft.rules.includes(r.id)).map((r) => (
                    <div key={r.id} className="rule-chip">
                      <span className="rule-chip-mark">✓</span>
                      <span>{r.name}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {asSpectator ? (
              <div className="sheet spectator-cta">
                <div className="spectator-cta-eye" />
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>
                    You're a spectator
                  </div>
                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    You'll see every card as it's revealed, but you can't play one. If a player
                    drops, you'll be offered the seat.
                  </div>
                </div>
              </div>
            ) : isHost ? (
              <button
                className="btn btn-primary btn-lg btn-block"
                disabled={players.length < 3}
                onClick={() => go('game')}
              >
                {players.length < 3 ? `Waiting for ${3 - players.length} more…` : 'Start game'}
              </button>
            ) : (
              <div className="sheet" style={{ textAlign: 'center', padding: 20 }}>
                <div className="muted">Waiting for host to start…</div>
                <div className="loading-dots" style={{ marginTop: 8 }}>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 4. GAME SESSION ─────────────────────────────────────────

function GameScreen({ go, draft, role, setRole }) {
  const [round, setRound] = useState(1)
  // phase: "picking" → "waiting" → "judging" → "reveal" → "transition"
  const [phase, setPhase] = useState('picking')
  const [selected, setSelected] = useState([]) // array of hand indices, in pick order
  const [revealIndex, setRevealIndex] = useState(-1)
  const [winnerIndex, setWinnerIndex] = useState(null)

  const prompt = window.PROMPT_CARDS[(round - 1) % window.PROMPT_CARDS.length]
  const blanks = Math.max(1, prompt.blanks || 1)
  const judge = window.PLAYERS[(round - 1) % window.PLAYERS.length]
  const isJudge = role === 'judge'

  const toggleSelect = (i) => {
    setSelected((prev) => {
      if (prev.includes(i)) return prev.filter((x) => x !== i)
      if (prev.length >= blanks) return [...prev.slice(1), i]
      return [...prev, i]
    })
  }

  // your hand
  const hand = useMemo(() => {
    const offset = ((round - 1) * 7) % window.RESPONSE_CARDS.length
    return Array.from({ length: 7 }).map(
      (_, i) => window.RESPONSE_CARDS[(offset + i) % window.RESPONSE_CARDS.length],
    )
  }, [round])

  // simulated submissions (face-down for picking phase / face-up for judging)
  const submissions = useMemo(() => {
    const list = window.PLAYERS.filter((p) => p.name !== judge.name).map((p, i) => ({
      player: p,
      // each submission has `blanks` fills
      fills: Array.from({ length: blanks }).map(
        (_, b) => window.RESPONSE_CARDS[(i * 3 + round * 5 + b * 7) % window.RESPONSE_CARDS.length],
      ),
    }))
    return list
  }, [round, judge.name, blanks])

  const submitCard = () => {
    if (selected.length < blanks) return
    setPhase('waiting')
    setTimeout(() => setPhase('judging'), 1200)
  }

  const startReveal = () => {
    setPhase('reveal')
    setRevealIndex(0)
    submissions.forEach((_, i) => {
      setTimeout(() => setRevealIndex(i + 1), 700 * (i + 1))
    })
  }

  const pickWinner = (i) => {
    setWinnerIndex(i)
    setTimeout(() => {
      setRound((r) => r + 1)
      setSelected([])
      setRevealIndex(-1)
      setWinnerIndex(null)
      setPhase(isJudge ? 'judging' : 'picking')
    }, 2600)
  }

  // ── HUD: scoreboard top, prompt center, hand bottom ──
  return (
    <div className="scene game-scene">
      <Topbar
        onHome={() => go('home')}
        right={
          <>
            <div className="pill">ROUND {String(round).padStart(2, '0')}</div>
            <div className="pill">
              <span className="dot live" />
              {draft.timer === 'Off' ? 'NO TIMER' : draft.timer.toUpperCase()}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => go('home')}>
              Leave
            </button>
          </>
        }
      />

      <div className="game-wrap">
        {/* Scoreboard */}
        <div className="scoreboard">
          {window.PLAYERS.map((p, i) => {
            const isCurrentJudge = p.name === judge.name
            return (
              <div
                key={p.name}
                className={`score-chip ${p.you ? 'you' : ''} ${isCurrentJudge ? 'is-judge' : ''}`}
              >
                <Avatar name={p.name} size="sm" you={p.you} />
                <div className="col" style={{ gap: 1 }}>
                  <div className="score-name">
                    {p.name === 'You' ? draft.username || 'You' : p.name}
                  </div>
                  <div className="score-meta">
                    {isCurrentJudge ? 'JUDGE' : `${p.score} pt${p.score === 1 ? '' : 's'}`}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Demo role toggle — kept always visible above stage */}
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 12 }}>
          <div className="role-toggle">
            <span className="muted" style={{ fontSize: 11, marginRight: 8 }}>
              DEMO ROLE
            </span>
            <div className="seg">
              <button
                className={`seg-btn ${role === 'player' ? 'active' : ''}`}
                onClick={() => setRole('player')}
              >
                Player
              </button>
              <button
                className={`seg-btn ${role === 'judge' ? 'active' : ''}`}
                onClick={() => setRole('judge')}
              >
                Judge
              </button>
            </div>
          </div>
        </div>

        {/* Stage — layout changes per phase */}
        {phase === 'picking' || phase === 'waiting' ? (
          <div className="stage stage-solo">
            <div className="stage-prompt stage-prompt-hero">
              <div className="eyebrow" style={{ marginBottom: 12 }}>
                The prompt · {judge.name === 'You' ? draft.username || 'You' : judge.name} is
                judging
              </div>
              <PromptCard size="xl" text={prompt.text} />
              <div className="pick-status">
                {phase === 'picking' &&
                  !isJudge &&
                  (blanks > 1 ? (
                    <span>
                      Pick <b>{blanks}</b> cards in order ({selected.length}/{blanks}).
                    </span>
                  ) : selected.length === 0 ? (
                    <span>Pick a card from your hand.</span>
                  ) : (
                    <span>Card selected. Hit submit when you're ready.</span>
                  ))}
                {phase === 'picking' && isJudge && (
                  <span>
                    You're the judge. Waiting for everyone to play…
                    <span className="loading-dots" style={{ marginLeft: 8 }}>
                      <span />
                      <span />
                      <span />
                    </span>
                  </span>
                )}
                {phase === 'waiting' && (
                  <span>
                    Card submitted. Waiting on others…
                    <span className="loading-dots" style={{ marginLeft: 8 }}>
                      <span />
                      <span />
                      <span />
                    </span>
                  </span>
                )}
              </div>
              {/* tiny progress indicator of who's submitted (face-down dots, not full cards) */}
              <div className="pick-progress">
                {submissions.map((s, i) => {
                  const submittedYou = phase === 'waiting'
                  // simulate: in waiting phase, all show submitted; in picking, none
                  const submitted = submittedYou
                  return (
                    <div
                      key={i}
                      className={`pick-pip ${submitted ? 'on' : ''}`}
                      title={s.player.name}
                    >
                      <span className="pick-pip-letter">{s.player.avatar}</span>
                    </div>
                  )
                })}
                <div className="pick-progress-label muted">
                  {phase === 'waiting'
                    ? `${submissions.length} of ${submissions.length} submitted`
                    : `0 of ${submissions.length} submitted`}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="stage">
            {/* Left: prompt card */}
            <div className="stage-prompt">
              <div className="eyebrow" style={{ marginBottom: 12 }}>
                The prompt · {judge.name === 'You' ? draft.username || 'You' : judge.name} is
                judging
              </div>
              <PromptCard size="xl" text={prompt.text} />
              {phase === 'reveal' && (
                <div
                  className="muted"
                  style={{ marginTop: 16, fontSize: 13, textAlign: 'center', maxWidth: 320 }}
                >
                  {revealIndex < submissions.length
                    ? `Revealing ${revealIndex + 1} of ${submissions.length}…`
                    : 'Pick your winner.'}
                </div>
              )}
            </div>

            {/* Right: submissions area */}
            <div className="stage-subs">
              <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
                <div className="eyebrow">
                  {phase === 'judging' && 'Awaiting judge'}
                  {phase === 'reveal' && 'Reveal'}
                </div>
              </div>

              {phase === 'judging' && (
                <div className="subs-grid subs-grid-large">
                  {submissions.flatMap((s, i) =>
                    Array.from({ length: blanks }).map((_, fi) => (
                      <div
                        key={`${i}-${fi}`}
                        className={`sub-card ${blanks > 1 ? 'multi-card' : ''} ${isJudge ? 'card-clickable' : ''}`}
                        onClick={() => isJudge && startReveal()}
                      >
                        {blanks > 1 && <div className="player-badge">{i + 1}</div>}
                        <CardBack size="md" />
                      </div>
                    )),
                  )}
                  {!isJudge && <div className="judge-note">Judge is reading. Hold tight.</div>}
                  {isJudge && <div className="judge-note">Click any card to start the reveal.</div>}
                </div>
              )}

              {phase === 'reveal' && (
                <div className="subs-grid subs-grid-large">
                  {submissions.flatMap((s, i) => {
                    const revealed = i < revealIndex
                    const isWinner = winnerIndex === i
                    const isLoser = winnerIndex != null && winnerIndex !== i
                    return s.fills.map((t, fi) => (
                      <div
                        key={`${i}-${fi}`}
                        className={`sub-card ${blanks > 1 ? 'multi-card' : ''} ${revealed ? '' : 'hidden-card'} ${isWinner ? 'is-winner' : ''} ${isLoser ? 'is-loser' : ''}`}
                        onClick={() => isJudge && revealed && winnerIndex == null && pickWinner(i)}
                      >
                        {blanks > 1 && <div className="player-badge">{i + 1}</div>}
                        {revealed ? (
                          <div className="flip-reveal">
                            <ResponseCard
                              size="md"
                              text={t}
                              onClick={isJudge && winnerIndex == null ? () => pickWinner(i) : null}
                            />
                            {isWinner && fi === 0 && (
                              <div className="winner-badge">
                                <div className="winner-by">
                                  <Avatar name={s.player.name} size="sm" />
                                  <span>
                                    +1{' '}
                                    {s.player.name === 'You'
                                      ? draft.username || 'You'
                                      : s.player.name}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <CardBack size="md" />
                        )}
                      </div>
                    ))
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Hand dock — only during picking phase for non-judge players */}
        {phase === 'picking' && !isJudge && (
          <div className="hand-dock">
            <div className="hand-dock-hd">
              <div className="eyebrow">
                {blanks > 1 ? `Your hand · pick ${blanks} in order` : 'Your hand · pick one'}
              </div>
              <button
                className="btn btn-primary btn-sm"
                disabled={selected.length < blanks}
                onClick={submitCard}
              >
                {selected.length < blanks
                  ? blanks > 1
                    ? `Pick ${blanks - selected.length} more`
                    : 'Pick a card'
                  : blanks > 1
                    ? 'Submit cards →'
                    : 'Submit card →'}
              </button>
            </div>
            <div className="hand">
              {hand.map((text, i) => {
                const pickIdx = selected.indexOf(i)
                const isSelected = pickIdx !== -1
                return (
                  <div
                    key={i}
                    className="hand-card-wrap deal"
                    style={{
                      '--rot': `${(i - 3) * 2.2}deg`,
                      animationDelay: `${i * 0.06}s`,
                      transform: `translateY(${isSelected ? -22 : Math.abs(i - 3) * 4}px) rotate(${(i - 3) * 2.2}deg)`,
                      zIndex: isSelected ? 99 : i,
                    }}
                  >
                    <ResponseCard
                      size="md"
                      text={text}
                      selected={isSelected}
                      onClick={() => toggleSelect(i)}
                    />
                    {isSelected && blanks > 1 && (
                      <div className="pick-order-badge">{pickIdx + 1}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Judge action bar — when in judging phase, give judge a clear next-step button */}
        {phase === 'judging' && isJudge && (
          <div className="judge-bar">
            <span className="muted">All cards in. Time to read them and pick a winner.</span>
            <button className="btn btn-primary btn-sm" onClick={startReveal}>
              Start reveal →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── JOIN GAME (mini modal screen) ──────────────────────────

function JoinScreen({ go, draft, setDraft, roomFull }) {
  const [code, setCode] = useState('')
  const [joinAs, setJoinAs] = useState('player')
  const valid = code.replace(/[^A-Z0-9]/g, '').length >= 6

  // If room is full, force spectator mode
  useEffect(() => {
    if (roomFull && joinAs === 'player') setJoinAs('spectator')
  }, [roomFull])

  const effectiveJoinAs = roomFull ? 'spectator' : joinAs

  return (
    <div className="scene">
      <Topbar onHome={() => go('home')} />
      <div className="join-wrap fade-in">
        <div className="eyebrow">Join an existing game</div>
        <h1 className="join-title">Got a room code?</h1>
        <p className="muted" style={{ maxWidth: 380, textAlign: 'center', lineHeight: 1.5 }}>
          Drop the 6-character code from your host. Pick a handle. Choose how you want to join.
        </p>
        <div className="sheet" style={{ width: '100%', maxWidth: 480, marginTop: 8 }}>
          <div className="field">
            <label className="field-label">Room code</label>
            <input
              className="input"
              style={{
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.16em',
                fontSize: 22,
                textAlign: 'center',
                textTransform: 'uppercase',
              }}
              placeholder="B7K-9MV"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </div>
          <div className="field" style={{ marginTop: 16 }}>
            <label className="field-label">Your handle</label>
            <input
              className="input"
              placeholder="e.g. priya_was_here"
              value={draft.username}
              onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
            />
          </div>

          <div className="field" style={{ marginTop: 16 }}>
            <label className="field-label">Join as</label>
            {roomFull ? (
              <div className="join-full-banner">
                <div className="join-full-banner-icon">!</div>
                <div className="grow">
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>
                    Player slots are full
                  </div>
                  <div className="muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
                    You can still join as a spectator — watch the chaos in real time. If a player
                    drops, you'll be offered the seat.
                  </div>
                </div>
              </div>
            ) : (
              <div className="join-as-grid">
                <button
                  type="button"
                  className={`join-as-card ${joinAs === 'player' ? 'on' : ''}`}
                  onClick={() => setJoinAs('player')}
                >
                  <div className="join-as-card-mark">
                    <div className="join-as-pip pip-1" />
                    <div className="join-as-pip pip-2" />
                  </div>
                  <div>
                    <div className="join-as-title">Player</div>
                    <div className="join-as-desc">Get a hand. Play cards. Cause harm.</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`join-as-card ${joinAs === 'spectator' ? 'on' : ''}`}
                  onClick={() => setJoinAs('spectator')}
                >
                  <div className="join-as-card-mark">
                    <div className="join-as-eye" />
                  </div>
                  <div>
                    <div className="join-as-title">Spectator</div>
                    <div className="join-as-desc">Watch only. React. Heckle in chat.</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          <button
            className="btn btn-primary btn-block btn-lg"
            style={{ marginTop: 20 }}
            disabled={!valid || draft.username.trim().length < 2}
            onClick={() => go(effectiveJoinAs === 'spectator' ? 'lobby-spectator' : 'lobby')}
          >
            {effectiveJoinAs === 'spectator' ? 'Join as spectator' : 'Join lobby'}
          </button>
          <button
            className="btn btn-ghost btn-block btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => go('home')}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// export to global
Object.assign(window, { HomeScreen, CreateScreen, LobbyScreen, GameScreen, JoinScreen })
