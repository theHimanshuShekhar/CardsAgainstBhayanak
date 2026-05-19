import { startSweeper } from './sweeper'
import { startKeepaliveEnforcer } from '~/ws/handler'
import { seedPacks } from './seed'
import { restoreRoundTimers } from './game-engine'
import { seedLogger, engineLogger } from './logger'

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
  startSweeper()
  startKeepaliveEnforcer()
  seedWithRetry()
  // S2-10: re-arm round timers lost when this process replaced the
  // previous one mid-round. Fire-and-forget; a transient DB error here
  // must not block boot.
  void restoreRoundTimers().catch((err) =>
    engineLogger.error({ err }, 'round timer restore failed'),
  )
}
