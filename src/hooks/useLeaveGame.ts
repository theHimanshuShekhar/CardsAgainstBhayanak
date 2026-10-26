import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useSession } from './useSession'

export function useLeaveGame() {
  const navigate = useNavigate()
  const { session, setSession } = useSession()
  const leavingRef = useRef(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)

  async function leaveGame() {
    if (!session || leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    setLeaveError(null)
    try {
      const response = await fetch(`/api/games/${session.roomCode}/leave`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      })
      if (!response.ok) throw new Error('Leave failed')
    } catch {
      setLeaveError('Could not confirm leaving the game. Please try again.')
      return
    } finally {
      leavingRef.current = false
      setLeaving(false)
    }
    setSession(null)
    void navigate({ to: '/' })
  }

  return { leaveGame, leaving, leaveError }
}
