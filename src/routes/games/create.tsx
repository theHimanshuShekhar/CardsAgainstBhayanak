import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Avatar } from '~/components/ui/Avatar'
import { CheckCard } from '~/components/ui/CheckCard'
import { useGameContext } from '~/contexts/GameContext'
import { useSession } from '~/hooks/useSession'
import { getOrCreateAnonId } from '~/lib/posthog-client'
import type { GameConfig, ModalRuleId, OrthogonalRuleId, Pack, RuleId } from '~/lib/types'

export const Route = createFileRoute('/games/create')({
  component: CreateScreen,
})

const TIMERS: GameConfig['timer'][] = ['30s', '60s', '90s', 'Off']

const BASE_PACK_SLUG = 'cah-base-set'
const isBasePack = (p: Pack) => p.slug === BASE_PACK_SLUG || /^CAH Base Set/i.test(p.name)

// Modal rules are mutually exclusive (≤ 1 active); "None" = none selected.
const MODAL_RULES: { id: ModalRuleId; name: string; desc: string }[] = [
  { id: 'godmode', name: 'God Is Dead', desc: 'No Czar — everyone votes each round.' },
  {
    id: 'survival',
    name: 'Survival of the Fittest',
    desc: 'Players take turns eliminating cards until one is left.',
  },
  {
    id: 'serious_business',
    name: 'Serious Business',
    desc: 'Czar ranks the top 3 (3 / 2 / 1 points).',
  },
]

const ORTHO_RULES: { id: OrthogonalRuleId; name: string; desc: string }[] = [
  { id: 'rebooting', name: 'Rebooting the Universe', desc: 'Spend 1 point to redraw your hand.' },
  { id: 'packing_heat', name: 'Packing Heat', desc: 'Pick-2 prompts deal an extra card.' },
  { id: 'rando', name: 'Rando Cardrissian', desc: 'An AI player auto-submits every round.' },
  {
    id: 'never_have_i_ever',
    name: 'Never Have I Ever',
    desc: 'Discard with a confession — 3 per game.',
  },
  {
    id: 'happy_ending',
    name: 'Happy Ending',
    desc: "Host can force a 'Make a Haiku' final round.",
  },
]

const MODAL_IDS = MODAL_RULES.map((r) => r.id) as readonly RuleId[]

function CreateScreen() {
  const navigate = useNavigate()
  const { draft, setDraft } = useGameContext()
  const { setSession } = useSession()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [packs, setPacks] = useState<Pack[]>([])

  // S2-6/S2-16: load packs and auto-select (and lock) the Core base set.
  useEffect(() => {
    let cancelled = false
    fetch('/api/packs')
      .then((r) => r.json() as Promise<{ packs: Pack[] }>)
      .then((data) => {
        if (cancelled) return
        setPacks(data.packs)
        const base = data.packs.find(isBasePack)
        if (base) {
          setDraft((d) => (d.packs.includes(base.id) ? d : { ...d, packs: [base.id, ...d.packs] }))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [setDraft])

  const baseId = packs.find(isBasePack)?.id
  const activeModal = (draft.rules.find((r) => MODAL_IDS.includes(r)) as ModalRuleId) ?? null
  const cardCount = packs
    .filter((p) => draft.packs.includes(p.id))
    .reduce((n, p) => n + p.cardCount, 0)

  function togglePack(id: string) {
    if (id === baseId) return // Core pack is locked in
    setDraft((d) => ({
      ...d,
      packs: d.packs.includes(id) ? d.packs.filter((p) => p !== id) : [...d.packs, id],
    }))
  }

  function selectModal(id: ModalRuleId | null) {
    setDraft((d) => {
      const withoutModal = d.rules.filter((r) => !MODAL_IDS.includes(r))
      return { ...d, rules: id ? [...withoutModal, id] : withoutModal }
    })
  }

  function toggleOrtho(id: OrthogonalRuleId) {
    setDraft((d) => ({
      ...d,
      rules: d.rules.includes(id) ? d.rules.filter((r) => r !== id) : [...d.rules, id],
    }))
  }

  const canStart = draft.username.trim().length >= 2 && draft.packs.length >= 1

  async function handleCreate() {
    if (!canStart || loading) return
    setLoading(true)
    setError(null)
    try {
      const anonId = getOrCreateAnonId()
      const config: GameConfig = {
        maxPlayers: draft.maxPlayers,
        roundsToWin: draft.roundsToWin,
        timer: draft.timer,
        packs: draft.packs,
        rules: draft.rules,
      }
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: draft.username.trim(), anonId, config }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { message?: string }
        setError(body.message ?? 'Failed to create game')
        return
      }
      const { roomCode, playerId, sessionToken } = (await res.json()) as {
        roomCode: string
        playerId: string
        sessionToken: string
      }
      setSession({
        roomCode,
        playerId,
        sessionToken,
        username: draft.username.trim(),
        role: 'player',
        anonId,
      })
      void navigate({ to: '/games/$code/lobby', params: { code: roomCode } })
    } catch {
      setError('Network error — please try again')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="scene">
      <Topbar
        right={
          <button className="btn btn-ghost btn-sm" onClick={() => navigate({ to: '/' })}>
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
          <div className="create-col">
            <div className="sheet">
              <div className="sheet-hd">
                <div>
                  <div className="sheet-title">Your handle</div>
                  <div className="sheet-sub">This is how everyone in the lobby will see you.</div>
                </div>
              </div>
              <div className="row" style={{ gap: 14 }}>
                <Avatar name={draft.username || '?'} size="lg" you />
                <input
                  className="input grow"
                  aria-label="Your handle"
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
                  <div className="sheet-sub">You can change these before the game starts.</div>
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
                  <div className="seg" role="radiogroup" aria-label="Round timer">
                    {TIMERS.map((t) => (
                      <button
                        key={t}
                        role="radio"
                        aria-checked={draft.timer === t}
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
                {packs.map((p) => {
                  const locked = p.id === baseId
                  return (
                    <CheckCard
                      key={p.id}
                      on={draft.packs.includes(p.id)}
                      disabled={locked}
                      onClick={() => togglePack(p.id)}
                      title={p.name}
                      meta={`${p.cardCount.toLocaleString()}${locked ? ' · LOCKED IN' : ''}`}
                    />
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
              <div className="sheet-sub" style={{ marginBottom: 8 }}>
                Game mode — pick at most one
              </div>
              <div className="rule-grid">
                <CheckCard
                  on={activeModal === null}
                  onClick={() => selectModal(null)}
                  title="None"
                  description="Classic — the Czar picks the funniest card."
                />
                {MODAL_RULES.map((r) => (
                  <CheckCard
                    key={r.id}
                    on={activeModal === r.id}
                    onClick={() => selectModal(activeModal === r.id ? null : r.id)}
                    title={r.name}
                    description={r.desc}
                  />
                ))}
              </div>
              <div className="sheet-sub" style={{ margin: '14px 0 8px' }}>
                Extras — stack freely
              </div>
              <div className="rule-grid">
                {ORTHO_RULES.map((r) => (
                  <CheckCard
                    key={r.id}
                    on={draft.rules.includes(r.id)}
                    onClick={() => toggleOrtho(r.id)}
                    title={r.name}
                    description={r.desc}
                  />
                ))}
              </div>
            </div>
          </div>

          <aside className="create-aside">
            <div className="sheet">
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
                <span>Timer</span>
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
              <hr className="hr" style={{ margin: '16px 0' }} />
              {error && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 10, color: 'red' }}>
                  {error}
                </div>
              )}
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={!canStart || loading}
                onClick={() => void handleCreate()}
              >
                {loading ? 'Creating…' : 'Create lobby'}
              </button>
              <button
                className="btn btn-ghost btn-block btn-sm"
                onClick={() => navigate({ to: '/' })}
                style={{ marginTop: 8 }}
              >
                Cancel
              </button>
              {!canStart && (
                <div className="muted" style={{ fontSize: 11, marginTop: 12, textAlign: 'center' }}>
                  {draft.username.trim().length < 2
                    ? 'Pick a handle (2+ characters) to continue.'
                    : 'Select at least one card pack to continue.'}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
