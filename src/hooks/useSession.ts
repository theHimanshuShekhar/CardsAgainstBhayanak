import { useCallback, useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { CabSession } from '~/lib/types'

const KEY = 'cab_session'
// Versionless records are the original deployed format. Keep accepting them;
// all new writes carry a version so future formats can be rejected safely.
const storedSession = z.object({
  version: z.literal(1).optional(),
  roomCode: z.string().regex(/^[A-Z0-9]{6}$/),
  playerId: z.string().min(1),
  sessionToken: z.string().min(1),
  username: z.string().trim().min(2).max(20),
  role: z.enum(['player', 'spectator']),
  anonId: z.string().min(1),
})
const listeners = new Set<() => void>()
let cachedRaw: string | null = null
let cachedValue: CabSession | null = null
// A blocked write must still let this tab play. Reloading a browser that
// denies persistence starts signed out again.
let memoryOnly = false

function subscribe(cb: () => void) {
  listeners.add(cb)
  window.addEventListener('storage', cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener('storage', cb)
  }
}

function getSnapshot(): CabSession | null {
  if (memoryOnly) return cachedValue
  let raw: string | null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    return cachedValue
  }
  if (raw === cachedRaw) return cachedValue
  cachedRaw = raw
  cachedValue = null
  try {
    const result = storedSession.safeParse(JSON.parse(raw ?? 'null'))
    if (result.success) {
      cachedValue = result.data
    }
  } catch {
    // Invalid JSON is a signed-out snapshot, just like an invalid shape.
  }
  return cachedValue
}

function getServerSnapshot(): CabSession | null {
  return null
}
const getReadySnapshot = () => true
const getServerReadySnapshot = () => false

export function useSession() {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const ready = useSyncExternalStore(subscribe, getReadySnapshot, getServerReadySnapshot)
  const setSession = useCallback((s: CabSession | null) => {
    const raw = s ? JSON.stringify({ ...s, version: 1 }) : null
    try {
      if (raw) window.localStorage.setItem(KEY, raw)
      else window.localStorage.removeItem(KEY)
      memoryOnly = false
    } catch {
      memoryOnly = true
    }
    cachedRaw = raw
    cachedValue = s
    for (const cb of listeners) cb()
  }, [])
  return { session, setSession, ready }
}
