import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { Avatar } from '~/components/ui/Avatar'
import { Scoreboard } from '~/components/game/Scoreboard'
import { useSession } from '~/hooks/useSession'
import { captureEvent } from '~/lib/posthog-client'
import type { GameOverMode, PlayerScore } from '~/lib/types'

export const Route = createFileRoute('/games/$code/end')({
  component: EndScreen,
})

type LastGameOver = {
  finalScores: PlayerScore[]
  winnerId: string
  mode: GameOverMode
  totalRounds: number
}

function readLastGameOver(): LastGameOver | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = sessionStorage.getItem('cab_last_game_over')
    if (!raw) return null
    const parsed = JSON.parse(raw) as LastGameOver
    if (!Array.isArray(parsed.finalScores)) return null
    return parsed
  } catch {
    return null
  }
}

function EndScreen() {
  const navigate = useNavigate()
  const { code } = Route.useParams()
  const { setSession } = useSession()
  const [result] = useState<LastGameOver | null>(() => readLastGameOver())

  const handleGoHome = () => {
    captureEvent('cab_go_home_clicked', { previousRoomCode: code })
    setSession(null)
    void navigate({ to: '/' })
  }

  const handlePlayAgain = () => {
    captureEvent('cab_play_again_clicked', { previousRoomCode: code })
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

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 32 }}>
          <button className="btn btn-primary" onClick={handlePlayAgain}>
            Play again
          </button>
          <button className="btn btn-ghost" onClick={handleGoHome}>
            Go home
          </button>
        </div>
      </div>
    </div>
  )
}
