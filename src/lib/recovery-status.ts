export type RecoveryProgress = { total: number; recovered: number; pending: number }
export type RecoveryStatus = {
  ready: boolean
  stage: 'schema' | 'rooms' | 'ready'
  attempts: number
  rooms: RecoveryProgress | null
  connectionsReady: boolean
  nextRetryAt: number | null
}

// Production loads both source WS modules and bundled SSR modules. They must
// expose the same process status, including while SSR is still behind its gate.
const runtime = globalThis as typeof globalThis & { __cabRecovery?: RecoveryStatus }
export const recoveryStatus = (runtime.__cabRecovery ??= {
  ready: false,
  stage: 'schema',
  attempts: 0,
  rooms: null,
  connectionsReady: false,
  nextRetryAt: null,
})

export const recoveryRetryMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1))
