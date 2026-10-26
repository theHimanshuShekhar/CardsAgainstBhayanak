import { expect } from '@playwright/test'
import type { ServerToClientEvent, SessionState } from '../src/lib/types'

// Protocol clients follow the same retry contract as the browser. Each
// rejected request has no effect; unexpected errors must still fail the test.
export async function requestStateSnapshot(
  ws: WebSocket,
  events: ServerToClientEvent[],
): Promise<SessionState> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const after = events.length
    ws.send(JSON.stringify({ type: 'rejoin' }))
    await expect
      .poll(
        () =>
          events
            .slice(after)
            .find((event) => event.type === 'state_snapshot' || event.type === 'error'),
        { timeout: 10_000 },
      )
      .toBeTruthy()
    const reply = events
      .slice(after)
      .find((event) => event.type === 'state_snapshot' || event.type === 'error')!
    if (reply.type === 'state_snapshot') return reply.state
    expect(reply).toMatchObject({
      type: 'error',
      code: 'rate_limited',
      retryAfterMs: expect.any(Number),
    })
    if (reply.type === 'error') {
      expect(reply.retryAfterMs).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, reply.retryAfterMs! + 25))
    }
  }
  throw new Error('Snapshot retry budget exhausted')
}
