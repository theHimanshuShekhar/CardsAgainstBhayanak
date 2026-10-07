import { ErrorNotice } from '~/components/ui/ErrorNotice'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Avatar } from '~/components/ui/Avatar'
import { Scoreboard } from '~/components/game/Scoreboard'
import { useSession } from '~/hooks/useSession'
import { useGameSocket } from '~/hooks/useGameSocket'
import { captureEvent } from '~/lib/posthog-client'
import type { GameOverMode, GamePlayer, PlayerScore, ResetMode } from '~/lib/types'

export const Route = createFileRoute('/games/$code/end')({
  component: EndScreen,
})

type LastGameOver = {
  code: string
  finalScores: PlayerScore[]
  winnerId: string
  mode: GameOverMode
  totalRounds: number
}

// S3-NEW-E: reject (and clear) a payload whose roomCode doesn't match the
// /end route — sessionStorage outlives navigation, so a stale entry from
// a previous game would otherwise leak into a different room's end screen.
function readLastGameOver(code: string): LastGameOver | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem('cab_last_game_over')
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastGameOver>
    if (!Array.isArray(parsed.finalScores) || parsed.code !== code) {
      sessionStorage.removeItem('cab_last_game_over')
      return null
    }
    return parsed as LastGameOver
  } catch {
    return null
  }
}

function clearLastGameOver(): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.removeItem('cab_last_game_over')
  } catch {
    // sessionStorage write-disabled (private mode quirks); not fatal.
  }
}

function EndScreen() {
  const navigate = useNavigate()
  const { code } = Route.useParams()
  const { session, setSession } = useSession()
  const [result] = useState<LastGameOver | null>(() => readLastGameOver(code))

  // #3: the end screen joins the room socket purely as a redirect hub —
  // when the host resets, every client (host included) routes through
  // the lobby, which already forwards to /session once a rematch starts.
  const [players, setPlayers] = useState<GamePlayer[]>([])
  const [resetting, setResetting] = useState<ResetMode | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  const { on } = useGameSocket(code, session?.sessionToken ?? null, session?.anonId ?? '')

  useEffect(() => {
    return on((event) => {
      if (event.type === 'game_reset') {
        // S3-NEW-E: rematch/back-to-lobby leaves /end — the cached result
        // is now stale for the next game in the same tab.
        clearLastGameOver()
        void navigate({ to: '/games/$code/lobby', params: { code } })
        return
      }
      if (event.type === 'state_snapshot') {
        // A rematch was already live by the time this socket connected.
        clearLastGameOver()
        void navigate({ to: '/games/$code/session', params: { code } })
        return
      }
      if (event.type === 'lobby_snapshot') {
        if (event.gameStatus === 'active' || event.gameStatus === 'paused') {
          clearLastGameOver()
          void navigate({ to: '/games/$code/session', params: { code } })
          return
        }
        if (event.gameStatus === 'lobby') {
          clearLastGameOver()
          void navigate({ to: '/games/$code/lobby', params: { code } })
          return
        }
        if (event.gameStatus === 'abandoned') {
          clearLastGameOver()
          setSession(null)
          void navigate({ to: '/' })
          return
        }
        // Still 'ended' — only the roster matters here (host detection).
        setPlayers(event.players)
      }
      if (event.type === 'auth_error') {
        clearLastGameOver()
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
    clearLastGameOver()
    setSession(null)
    void navigate({ to: '/' })
  }

  const handlePlayAgain = () => {
    captureEvent('cab_play_again_clicked', { previousRoomCode: code })
    clearLastGameOver()
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
