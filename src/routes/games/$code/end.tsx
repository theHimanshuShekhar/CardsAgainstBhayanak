import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { Topbar } from '~/components/ui/Topbar'
import { useSession } from '~/hooks/useSession'
import { captureEvent } from '~/lib/posthog-client'

export const Route = createFileRoute('/games/$code/end')({
  component: EndScreen,
})

function EndScreen() {
  const navigate = useNavigate()
  const { code } = Route.useParams()
  const { setSession } = useSession()

  useEffect(() => {
    captureEvent('cab_game_ended', { roomCode: code })
  }, [code])

  const handleGoHome = () => {
    captureEvent('cab_go_home_clicked', { previousRoomCode: code })
    setSession(null)
    void navigate({ to: '/' })
  }

  const handlePlayAgain = () => {
    captureEvent('cab_play_again_clicked', { previousRoomCode: code })
    void navigate({ to: '/games/create' })
  }

  return (
    <div className="scene">
      <Topbar
        right={
          <button className="btn btn-ghost btn-sm" onClick={handleGoHome}>
            Go home
          </button>
        }
      />
      <div className="create-wrap fade-in" style={{ textAlign: 'center', paddingTop: 80 }}>
        <div className="eyebrow">Game over</div>
        <h1 className="create-title">That&apos;s a wrap</h1>
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
