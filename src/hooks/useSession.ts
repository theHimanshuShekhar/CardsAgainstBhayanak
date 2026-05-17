import { useCallback, useSyncExternalStore } from 'react'
import type { CabSession } from '~/lib/types'

const KEY = 'cab_session'

// S3: `cab_session` lives in localStorage — an external store. Reading it in
// a `useState` initialiser runs during hydration and a non-null value there
// mismatches the server-rendered `null`. `useSyncExternalStore` with a
// `null` server snapshot is the sanctioned fix: it renders `null` on the
// server and the first client paint (matching SSR), then re-renders with the
// stored session, with no hydration mismatch and no setState-in-effect.
const listeners = new Set<() => void>()
let cachedRaw: string | null = null
let cachedValue: CabSession | null = null

function subscribe(cb: () => void) {
  listeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}

// Must return a stable reference when the stored string is unchanged,
// otherwise useSyncExternalStore loops re-rendering.
function getSnapshot(): CabSession | null {
  const raw = localStorage.getItem(KEY)
  if (raw === cachedRaw) return cachedValue
  cachedRaw = raw
  cachedValue = raw ? (JSON.parse(raw) as CabSession) : null
  return cachedValue
}

function getServerSnapshot(): CabSession | null {
  return null
}

export function useSession() {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const setSession = useCallback((s: CabSession | null) => {
    if (s) localStorage.setItem(KEY, JSON.stringify(s))
    else localStorage.removeItem(KEY)
    for (const cb of listeners) cb()
  }, [])

  return { session, setSession }
}
