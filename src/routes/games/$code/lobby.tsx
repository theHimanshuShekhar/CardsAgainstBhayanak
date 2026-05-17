import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Avatar } from '~/components/ui/Avatar'
import { formatRoomCode } from '~/lib/code-gen'
import { useSession } from '~/hooks/useSession'
import { useGameSocket } from '~/hooks/useGameSocket'
import { captureEvent } from '~/lib/posthog-client'
import type { GameConfig, GamePlayer } from '~/lib/types'

export const Route = createFileRoute('/games/$code/lobby')({
  component: LobbyScreen,
})

function LobbyScreen() {
  const navigate = useNavigate()
  const { code } = Route.useParams()
  const { session, setSession } = useSession()
  const formatted = formatRoomCode(code)

  const [players, setPlayers] = useState<GamePlayer[]>([])
  const [config, setConfig] = useState<GameConfig | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const { on } = useGameSocket(code, session?.sessionToken ?? null, session?.anonId ?? '')

  useEffect(() => {
    return on((event) => {
      // S2-5: pre-game roster + config, and the reconnect-hub redirect.
      if (event.type === 'lobby_snapshot') {
        if (event.gameStatus === 'active' || event.gameStatus === 'paused') {
          void navigate({ to: '/games/$code/session', params: { code } })
          return
        }
        if (event.gameStatus === 'ended') {
          void navigate({ to: '/games/$code/end', params: { code } })
          return
        }
        if (event.gameStatus === 'abandoned') {
          setSession(null)
          void navigate({ to: '/' })
          return
        }
        setPlayers(event.players)
        setConfig(event.config)
      }
      // A live game answers rejoin with a full state_snapshot, never
      // lobby_snapshot — the lobby is just the reconnect entry point.
      if (event.type === 'state_snapshot') {
        void navigate({ to: '/games/$code/session', params: { code } })
      }
      if (event.type === 'player_joined') {
        setPlayers((prev) => {
          if (prev.some((p) => p.id === event.player.id)) return prev
          return [...prev, event.player]
        })
      }
      if (event.type === 'player_left') {
        setPlayers((prev) => prev.filter((p) => p.id !== event.playerId))
      }
      if (event.type === 'game_started') {
        void navigate({ to: '/games/$code/session', params: { code } })
      }
      if (event.type === 'auth_error') {
        setSession(null)
        void navigate({ to: '/' })
      }
    })
  }, [on, code, navigate, setSession])

  const isHost = session?.playerId != null && players.find((p) => p.id === session.playerId)?.isHost
  const canStart =
    isHost && players.filter((p) => p.role === 'player' && p.status === 'active').length >= 3

  async function handleStart() {
    if (!canStart || starting || !session) return
    setStarting(true)
    setStartError(null)
    try {
      const res = await fetch(`/api/games/${code}/start`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      })
      if (!res.ok) {
        const body = (await res.json()) as { message?: string }
        setStartError(body.message ?? 'Could not start game')
      }
    } catch {
      setStartError('Network error')
    } finally {
      setStarting(false)
    }
  }

  async function handleCopyCode() {
    await navigator.clipboard.writeText(formatted)
    captureEvent('cab_room_code_copied', { roomCode: code, format: 'code' })
  }

  async function handleCopyLink() {
    await navigator.clipboard.writeText(window.location.href)
    captureEvent('cab_room_code_copied', { roomCode: code, format: 'link' })
  }

  async function handleLeave() {
    setSession(null)
    void navigate({ to: '/' })
  }

  return (
    <div className="scene">
      <Topbar
        right={
          <>
            <div className="pill">
              <span className="dot live" />
              Lobby
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => void handleLeave()}>
              Leave
            </button>
          </>
        }
      />
      <div className="lobby-wrap fade-in">
        <div className="lobby-hd">
          <div>
            <div className="eyebrow">Waiting for players</div>
            <h1 className="lobby-title">The lobby</h1>
          </div>
          <div className="lobby-code-card">
            <div className="eyebrow">Room code</div>
            <div className="lobby-code">{formatted}</div>
            <div className="lobby-code-actions">
              <button className="btn btn-dark btn-sm" onClick={() => void handleCopyCode()}>
                Copy code
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => void handleCopyLink()}>
                Copy link
              </button>
            </div>
          </div>
        </div>

        <div className="lobby-grid">
          <div className="sheet">
            <div className="sheet-hd">
              <div className="sheet-title">Players ({players.length})</div>
            </div>
            <div className="player-list">
              {players.map((p) => (
                <div key={p.id} className="player-row">
                  <Avatar name={p.username} you={p.id === session?.playerId} />
                  <div className="grow">
                    <div className="player-name">
                      {p.username}
                      {p.id === session?.playerId && <span className="player-you">YOU</span>}
                      {p.isHost && <span className="player-host">HOST</span>}
                    </div>
                  </div>
                  <div className="ready-dot" />
                </div>
              ))}
              {Array.from({ length: Math.max(0, 3 - players.length) }).map((_, i) => (
                <div key={i} className="player-row player-row-empty">
                  <div className="avatar" style={{ opacity: 0.2 }}>
                    ·
                  </div>
                  <div className="grow muted" style={{ fontSize: 13 }}>
                    Waiting…
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="sheet">
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                Game config
              </div>
              <div className="summary-row">
                <span>Score to win</span>
                <b>{config ? config.roundsToWin : '—'}</b>
              </div>
              <div className="summary-row">
                <span>Max players</span>
                <b>{config ? config.maxPlayers : '—'}</b>
              </div>
              <div className="summary-row">
                <span>Timer</span>
                <b>{config ? config.timer : '—'}</b>
              </div>
            </div>
            {startError && (
              <div className="muted" style={{ fontSize: 13, color: 'red' }}>
                {startError}
              </div>
            )}
            {isHost ? (
              <button
                className="btn btn-primary btn-block btn-lg"
                disabled={!canStart || starting}
                onClick={() => void handleStart()}
              >
                {starting ? 'Starting…' : canStart ? 'Start game' : 'Waiting for players (3+)'}
              </button>
            ) : (
              <button className="btn btn-primary btn-block btn-lg" disabled>
                Waiting for host to start…
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
