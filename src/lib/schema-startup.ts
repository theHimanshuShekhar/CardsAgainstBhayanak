import { serve, type Server } from 'srvx'
import { manageSchema } from '../db/migrations'
import { recoveryRetryMs, recoveryStatus } from './recovery-status'

function unavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'CONNECT_TIMEOUT',
    'CONNECTION_CLOSED',
    '57P01', // administrative shutdown
    '57P02', // crash shutdown
    '57P03', // cannot connect yet
    '53300', // too many connections
  ].includes(String(error.code))
}

// Keep engines, jobs and ordinary traffic behind schema validation. Only a
// transient transport/server outage opens the temporary health responder;
// schema policy, credentials and configuration errors still refuse startup.
export async function waitForSchema(port: number): Promise<void> {
  let waitingServer: Server | undefined
  try {
    for (let attempt = 1; ; attempt++) {
      recoveryStatus.attempts = attempt
      recoveryStatus.nextRetryAt = null
      try {
        await manageSchema('check')
        return
      } catch (error) {
        if (!unavailable(error)) throw error
        const delay = recoveryRetryMs(attempt)
        recoveryStatus.nextRetryAt = Date.now() + delay
        console.error(`Schema storage unavailable; retrying in ${delay}ms`)
        if (!waitingServer) {
          const { healthResponse } = await import('./health')
          waitingServer = serve({
            port,
            hostname: '0.0.0.0',
            fetch: (request) =>
              new URL(request.url).pathname === '/api/healthz'
                ? healthResponse()
                : new Response('Server recovery in progress', { status: 503 }),
          })
          await waitingServer.ready()
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  } finally {
    await waitingServer?.close(true)
  }
}
