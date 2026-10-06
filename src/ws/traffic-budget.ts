// Process-local ingress/work limits. No Redis/DB work is needed for admission.
// Buckets survive socket close to prevent reconnects from resetting a budget.
const IDLE_MS = 120_000
const MAX_IDENTITIES = 4096
const AUTH_TIMEOUT_MS = 15_000
const identities = new Map<string, Identity>()
let connections = 0
let pending = 0
let nextPrune = 0

type Bucket = { tokens: number; updatedAt: number }
type Identity = {
  buckets: Map<string, Bucket>
  touchedAt: number
  connections: number
  pending: number
  working: number
}

function identity(key: string): Identity | undefined {
  const now = Date.now()
  if (now >= nextPrune) {
    for (const [key, value] of identities) {
      if (!value.connections && !value.working && now - value.touchedAt >= IDLE_MS)
        identities.delete(key)
    }
    nextPrune = now + 10_000
  }
  let value = identities.get(key)
  if (!value) {
    if (identities.size >= MAX_IDENTITIES) return
    value = { buckets: new Map(), touchedAt: now, connections: 0, pending: 0, working: 0 }
    identities.set(key, value)
  }
  value.touchedAt = now
  return value
}

function take(value: Identity, name: string, capacity: number, intervalMs: number): number {
  const now = Date.now()
  let bucket = value.buckets.get(name)
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now }
    value.buckets.set(name, bucket)
  }
  return consume(bucket, capacity, intervalMs, now)
}

function consume(bucket: Bucket, capacity: number, intervalMs: number, now: number): number {
  bucket.tokens = Math.min(
    capacity,
    bucket.tokens + ((now - bucket.updatedAt) * capacity) / intervalMs,
  )
  bucket.updatedAt = now
  if (bucket.tokens < 1) return Math.ceil(((1 - bucket.tokens) * intervalMs) / capacity)
  bucket.tokens -= 1
  return 0
}

export type ConnectionLease = {
  attach(onTimeout: () => void): void
  authenticated(): void
  release(): void
  frame(): number
  authenticate(): number
}

export function admitConnection(ip: string): { lease?: ConnectionLease; retryAfterMs: number } {
  const value = identity(`ip:${ip}`)
  if (!value) return { retryAfterMs: IDLE_MS }
  const retryAfterMs = take(value, 'connections', 120, 60_000)
  if (retryAfterMs) return { retryAfterMs }
  if (connections >= 1024 || value.connections >= 64 || pending >= 256 || value.pending >= 16)
    return { retryAfterMs: AUTH_TIMEOUT_MS }
  connections++
  pending++
  value.connections++
  value.pending++
  let released = false
  let awaitingAuth = true
  let onTimeout: (() => void) | undefined
  const clearPending = () => {
    if (!awaitingAuth) return
    awaitingAuth = false
    pending--
    value.pending--
    clearTimeout(timer)
  }
  const release = () => {
    if (released) return
    released = true
    clearPending()
    connections--
    value.connections--
    value.touchedAt = Date.now()
  }
  // Also releases abandoned/invalid native upgrades that never reach open.
  const timer = setTimeout(() => {
    release()
    onTimeout?.()
  }, AUTH_TIMEOUT_MS)
  timer.unref()
  return {
    retryAfterMs: 0,
    lease: {
      attach(callback) {
        onTimeout = callback
        if (released) callback()
      },
      authenticated: clearPending,
      release,
      frame: () => (released ? AUTH_TIMEOUT_MS : take(value, 'frames', 600, 60_000)),
      authenticate: () => take(value, 'auth', 60, 60_000),
    },
  }
}

export function admitFrame(
  code: string,
  playerId: string | undefined,
  socketBucket: { tokens: number; updatedAt: number },
): number {
  // Cheap malformed/pre-auth frames are bounded too, before JSON/schema work.
  const now = Date.now()
  const retryAfterMs = consume(socketBucket, 120, 60_000, now)
  if (retryAfterMs) return retryAfterMs
  if (!playerId) return 0
  const value = identity(`player:${code}:${playerId}`)
  return value ? take(value, 'frames', 120, 60_000) : IDLE_MS
}

export function admitCommand(
  code: string,
  playerId: string,
  type: string,
): { retryAfterMs: number; release?: () => void } {
  const value = identity(`player:${code}:${playerId}`)
  if (!value) return { retryAfterMs: IDLE_MS }
  // Pings pay the frame budget and do not consume the gameplay command allowance.
  if (type === 'ping') return { retryAfterMs: 0 }
  let retryAfterMs = take(value, 'commands', 60, 60_000)
  if (!retryAfterMs && type === 'rejoin') retryAfterMs = take(value, 'snapshots', 6, 10_000)
  if (retryAfterMs) return { retryAfterMs }
  // Bound concurrently running commands, including snapshot requests across sockets.
  if (value.working >= 2) return { retryAfterMs: 250 }
  value.working++
  return {
    retryAfterMs: 0,
    release: () => {
      value.working--
      value.touchedAt = Date.now()
    },
  }
}
