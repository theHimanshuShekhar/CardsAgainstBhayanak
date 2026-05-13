import { useCallback, useState } from 'react'
import type { CabSession } from '~/lib/types'

const KEY = 'cab_session'

export function useSession() {
  const [session, setSessionState] = useState<CabSession | null>(() => {
    if (typeof window === 'undefined') return null
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as CabSession) : null
  })

  const setSession = useCallback((s: CabSession | null) => {
    setSessionState(s)
    if (typeof window === 'undefined') return
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
  }, [])

  return { session, setSession }
}
