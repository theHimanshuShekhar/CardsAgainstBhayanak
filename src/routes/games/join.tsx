import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Avatar } from '~/components/ui/Avatar'
import { normalizeRoomCode } from '~/lib/code-gen'
import { useSession } from '~/hooks/useSession'
import { getOrCreateAnonId } from '~/lib/posthog-client'
import type { Role } from '~/lib/types'

export const Route = createFileRoute('/games/join')({
  component: JoinScreen,
})

function JoinScreen() {
  const navigate = useNavigate()
  const { setSession } = useSession()
  const [username, setUsername] = useState('')
  const [code, setCode] = useState('')
  const [role, setRole] = useState<Role>('player')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const canJoin = username.trim().length >= 2 && normalizeRoomCode(code).length === 6

  async function handleJoin() {
    if (!canJoin || loading) return
    setLoading(true)
    setError(null)
    const normalized = normalizeRoomCode(code)
    try {
      const anonId = getOrCreateAnonId()
      const res = await fetch(`/api/games/${normalized}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), anonId, role }),
      })
      if (!res.ok) {
        const body = (await res.json()) as { message?: string }
        setError(body.message ?? 'Could not join game')
        return
      }
      const { playerId, sessionToken } = (await res.json()) as {
        playerId: string
        sessionToken: string
        status: string
        gameStatus: string
      }
      setSession({
        roomCode: normalized,
        playerId,
        sessionToken,
        username: username.trim(),
        role,
        anonId,
      })
      void navigate({ to: '/games/$code/lobby', params: { code: normalized } })
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
      <div className="join-wrap fade-in">
        <div className="eyebrow">Join a game</div>
        <h1 className="join-title">Enter the room</h1>

        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label className="field-label">Room code</label>
            <input
              className="input"
              aria-label="Room code"
              placeholder="e.g. B7K-9MV"
              value={code}
              maxLength={7}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.12em', fontSize: 22 }}
            />
          </div>

          <div className="field">
            <label className="field-label">Your handle</label>
            <div className="row" style={{ gap: 14 }}>
              <Avatar name={username || '?'} size="lg" you />
              <input
                className="input grow"
                aria-label="Your handle"
                placeholder="e.g. priya_was_here"
                value={username}
                maxLength={20}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label">Join as</label>
            <div className="join-as-grid">
              <button
                className={`join-as-card ${role === 'player' ? 'on' : ''}`}
                onClick={() => setRole('player')}
              >
                <div className="join-as-card-mark">
                  <span className="join-as-pip pip-1" />
                  <span className="join-as-pip pip-2" />
                </div>
                <div>
                  <div className="join-as-title">Player</div>
                  <div className="join-as-desc">Submit cards, judge rounds, win points.</div>
                </div>
              </button>
              <button
                className={`join-as-card ${role === 'spectator' ? 'on' : ''}`}
                onClick={() => setRole('spectator')}
              >
                <div className="join-as-card-mark">
                  <span className="join-as-eye" />
                </div>
                <div>
                  <div className="join-as-title">Spectator</div>
                  <div className="join-as-desc">Watch only. No card play, no points.</div>
                </div>
              </button>
            </div>
          </div>

          {error && (
            <div className="muted" style={{ fontSize: 13, color: 'red' }}>
              {error}
            </div>
          )}

          <button
            className="btn btn-primary btn-block btn-lg"
            disabled={!canJoin || loading}
            onClick={() => void handleJoin()}
          >
            {loading ? 'Joining…' : 'Join game'}
          </button>
        </div>
      </div>
    </div>
  )
}
