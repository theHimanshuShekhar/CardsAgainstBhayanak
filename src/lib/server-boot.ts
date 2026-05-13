import { startSweeper } from './sweeper'
import { startKeepaliveEnforcer } from '~/ws/handler'

let started = false

export function ensureServerBoot(): void {
  if (started || process.env['NODE_ENV'] === 'test') return
  started = true
  startSweeper()
  startKeepaliveEnforcer()
}
