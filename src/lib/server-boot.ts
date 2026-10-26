import { startSweeper } from './sweeper'
import { startKeepaliveEnforcer } from '~/ws/handler'
import { seedPacks } from './seed'
import { restoreRoundTimers, restoreDisconnectDeadlines } from './game-engine'
import { seedLogger, engineLogger } from './logger'
import { recoveryRetryMs, recoveryStatus } from './recovery-status'

let started = false

// Fire the card seed in the background. It's idempotent (ON CONFLICT DO
// NOTHING), so retry on failure until it succeeds, then stop retrying.
function seedWithRetry(): void {
  const attempt = async (): Promise<boolean> => {
    try {
      await seedPacks()
      return true
    } catch (err) {
      seedLogger.error({ err }, 'seed failed; retrying in 5m')
      return false
    }
  }
  void attempt().then((ok) => {
    if (ok) return
    const timer = setInterval(() => {
      void attempt().then((done) => {
        if (done) clearInterval(timer)
      })
    }, 5 * 60_000)
  })
}

export function ensureServerBoot(): void {
  if (started) return
  started = true
  let reconciling = false
  let reconciliation: Promise<void> | undefined
  const reconcile = () => {
    if (reconciling) return reconciliation!
    reconciling = true
    reconciliation = restoreDisconnectDeadlines().finally(() => {
      reconciling = false
    })
    return reconciliation
  }
  setInterval(() => {
    void reconcile().catch((err) => engineLogger.error({ err }, 'disconnect recovery failed'))
  }, 1000).unref()
  startSweeper()
  startKeepaliveEnforcer()
  seedWithRetry()
  recoveryStatus.stage = 'rooms'
  recoveryStatus.attempts = 0
  const recover = async (): Promise<void> => {
    recoveryStatus.attempts++
    recoveryStatus.nextRetryAt = null
    try {
      const results = await Promise.allSettled([
        reconcile().then(
          () => {
            recoveryStatus.connectionsReady = true
          },
          (err) => {
            recoveryStatus.connectionsReady = false
            throw err
          },
        ),
        restoreRoundTimers((progress) => {
          recoveryStatus.rooms = progress
        }),
      ])
      const failures = results.filter((result) => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason))
      recoveryStatus.ready = true
      recoveryStatus.stage = 'ready'
    } catch (err) {
      const delay = recoveryRetryMs(recoveryStatus.attempts)
      recoveryStatus.nextRetryAt = Date.now() + delay
      engineLogger.error({ err, delay }, 'room recovery incomplete; retrying')
      setTimeout(() => void recover(), delay).unref()
    }
  }
  void recover()
}
