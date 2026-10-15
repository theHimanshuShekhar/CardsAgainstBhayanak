import { ErrorNotice } from '~/components/ui/ErrorNotice'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Avatar } from '~/components/ui/Avatar'
import { Scoreboard } from '~/components/game/Scoreboard'
import { useSession } from '~/hooks/useSession'
import { useGameSocket } from '~/hooks/useGameSocket'
import { captureEvent } from '~/lib/posthog-client'
import type { EndedMatchResult, GamePlayer, ResetMode } from '~/lib/types'

export const Route = createFileRoute('/games/$code/end')({
  component: EndScreen,
})

function EndScreen() {
  const navigate = useNavigate()
  const { code } = Route.useParams()
  const { session, setSession } = useSession()
  // SSR and the first browser render share this empty state. Only the
  // authenticated current-match snapshot can supply a result; old tab-local
  // game_over events cannot establish which match this room now represents.
  const [ended, setEnded] = useState<{ code: string; result: EndedMatchResult } | null>(null)
  const result = ended?.code === code ? ended.result : null

  // The end screen recovers the result and follows host resets over the room socket —
  // when the host resets, every client (host included) routes through
  // the lobby, which already forwards to /session once a rematch starts.
  const [players, setPlayers] = useState<GamePlayer[]>([])
  const [resetting, setResetting] = useState<ResetMode | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  const { on } = useGameSocket(code, session?.sessionToken ?? null, session?.anonId ?? '')

  useEffect(() => {
    return on((event) => {
      if (event.type === 'game_reset') {
        setEnded(null)
        void navigate({ to: '/games/$code/lobby', params: { code } })
        return
      }
      if (event.type === 'state_snapshot') {
        // A rematch was already live by the time this socket connected.
        setEnded(null)
        void navigate({ to: '/games/$code/session', params: { code } })
        return
      }
      if (event.type === 'lobby_snapshot') {
        if (event.gameStatus === 'active' || event.gameStatus === 'paused') {
          setEnded(null)
          void navigate({ to: '/games/$code/session', params: { code } })
          return
        }
        if (event.gameStatus === 'lobby') {
          setEnded(null)
          void navigate({ to: '/games/$code/lobby', params: { code } })
          return
        }
        if (event.gameStatus === 'abandoned') {
          setEnded(null)
          setSession(null)
          void navigate({ to: '/' })
          return
        }
        setPlayers(event.players)
        setEnded(event.result ? { code, result: event.result } : null)
      }
      if (event.type === 'host_changed') {
        setPlayers((prev) => prev.map((p) => ({ ...p, isHost: p.id === event.hostId })))
      }
      if (event.type === 'player_left') {
        setPlayers((prev) => prev.filter((p) => p.id !== event.playerId))
      }
      if (event.type === 'auth_error') {
        setEnded(null)
        setSession(null)
        void navigate({ to: '/' })
      }
    })
  }, [on, code, navigate, setSession])

  const isHost =
    session?.playerId != null && players.find((p) => p.id === session.playerId)?.isHost === true

  const handleReset = async (mode: ResetMode) => {
    if (!session || resetting) return
    setResetting(mode)
    setResetError(null)
    captureEvent('cab_game_reset_clicked', { roomCode: code, mode })
    try {
      const res = await fetch(`/api/games/${code}/reset`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string }
        setResetError(body.message ?? 'Could not reset the game')
        setResetting(null)
      }
      // Success: the game_reset WS event drives navigation.
    } catch {
      setResetError('Network error')
      setResetting(null)
    }
  }

  const handleGoHome = () => {
    captureEvent('cab_go_home_clicked', { previousRoomCode: code })
    setEnded(null)
    setSession(null)
    void navigate({ to: '/' })
  }

  const handlePlayAgain = () => {
    captureEvent('cab_play_again_clicked', { previousRoomCode: code })
    setEnded(null)
    void navigate({ to: '/games/create' })
  }

  const winner = result?.finalScores.find((s) => s.playerId === result.winnerId)
  const isRandoShame = result?.mode === 'rando_won'
  const isHappyEnding = result?.mode === 'happy_ending'
  const ranked = result ? [...result.finalScores].sort((a, b) => b.score - a.score) : []

  return (
    <div className="scene">
      <Topbar
        right={
          <button className="btn btn-ghost btn-sm" onClick={handleGoHome}>
            Go home
          </button>
        }
      />
      <div className="create-wrap fade-in" style={{ textAlign: 'center', paddingTop: 64 }}>
        {!result ? (
          <>
            <div className="eyebrow">Game over</div>
            <h1 className="create-title">That&apos;s a wrap</h1>
          </>
        ) : isRandoShame ? (
          <>
            <div className="eyebrow">Everlasting shame</div>
            <h1 className="create-title">Rando Cardrissian wins</h1>
            <p className="stats-lede" style={{ margin: '12px auto 0' }}>
              A pre-made deck beat you all. Every player goes home in a state of everlasting shame.
            </p>
          </>
        ) : (
          <>
            <div className="eyebrow">{isHappyEnding ? 'Happy ending' : 'Game over'}</div>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
                marginTop: 8,
              }}
            >
              <Avatar name={winner?.username ?? '?'} size="lg" />
              <h1 className="create-title" style={{ margin: 0 }}>
                {winner?.username ?? 'Nobody'} wins
              </h1>
            </div>
            {isHappyEnding && (
              <p className="stats-lede" style={{ margin: '12px auto 0' }}>
                Forced into a Haiku for the final round. Poetic.
              </p>
            )}
          </>
        )}

        {result && (
          <>
            <p className="muted" style={{ marginTop: 12 }}>
              Decided over {result.totalRounds} round{result.totalRounds === 1 ? '' : 's'}.
            </p>
            <div style={{ marginTop: 24, display: 'flex', justifyContent: 'center' }}>
              <Scoreboard scores={ranked} czarId={null} />
            </div>
          </>
        )}

        {isHost ? (
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 32 }}>
            <button
              className="btn btn-primary"
              disabled={resetting != null}
              onClick={() => void handleReset('rematch')}
            >
              {resetting === 'rematch' ? 'Starting…' : 'Rematch'}
            </button>
            <button
              className="btn btn-dark"
              disabled={resetting != null}
              onClick={() => void handleReset('lobby')}
            >
              {resetting === 'lobby' ? 'Returning…' : 'Back to lobby'}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 32 }}>
            <button className="btn btn-primary" disabled>
              Waiting for the host…
            </button>
          </div>
        )}

        {resetError && <ErrorNotice>{resetError}</ErrorNotice>}

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={handlePlayAgain}>
            New room
          </button>
          <button className="btn btn-ghost" onClick={handleGoHome}>
            Go home
          </button>
        </div>
      </div>
    </div>
  )
}
