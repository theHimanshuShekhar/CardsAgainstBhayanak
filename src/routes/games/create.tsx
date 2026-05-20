import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Avatar } from '~/components/ui/Avatar'
import { GameConfigEditor } from '~/components/game/GameConfigEditor'
import { useGameContext } from '~/contexts/GameContext'
import { useSession } from '~/hooks/useSession'
import { getOrCreateAnonId } from '~/lib/posthog-client'
import { isBasePack } from '~/lib/packs'
import type { GameConfig, Pack } from '~/lib/types'

export const Route = createFileRoute('/games/create')({
  component: CreateScreen,
})

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

            <GameConfigEditor
              value={{
                maxPlayers: draft.maxPlayers,
                roundsToWin: draft.roundsToWin,
                timer: draft.timer,
                packs: draft.packs,
                rules: draft.rules,
              }}
              onChange={(next) => setDraft((d) => ({ ...d, ...next }))}
              packs={packs}
            />
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
