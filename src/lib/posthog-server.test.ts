import { describe, expect, it } from 'vitest'
import { sanitizeServerException } from './posthog-server'

describe('safe server exception diagnostics', () => {
  it('preserves source locations without exposing a multiline message or arbitrary properties', () => {
    const error = new Error('private-card\n    at stolenToken (/private/token.ts:1:2)')
    error.stack = `${error.name}: ${error.message}\n    at submitCards (/app/src/lib/game-engine.ts:665:19)\n    at async message (/app/src/ws/handler.ts:341:9)`
    Object.assign(error, { sessionToken: 'secret', cause: new Error('private hand') })
    const safe = sanitizeServerException(error)
    expect(safe.message).toBe('WebSocket command failed')
    expect(safe.stack).toBe(
      'Error: WebSocket command failed\n    at /app/src/lib/game-engine.ts:665:19\n    at /app/src/ws/handler.ts:341:9',
    )
    expect(Object.keys(safe)).toEqual([])
  })

  it('falls back safely for malformed thrown values and unexpected stacks', () => {
    const unsafeStack = new Error('private-card')
    unsafeStack.stack = 'Error: private-card\nprivate-hand-and-token'
    const throwingGetter = new Error('secret')
    Object.defineProperty(throwingGetter, 'stack', {
      get: () => {
        throw new Error('secret')
      },
    })
    for (const value of [
      null,
      42,
      'private-token',
      { message: 'private-hand' },
      unsafeStack,
      throwingGetter,
    ]) {
      const safe = sanitizeServerException(value)
      expect(safe.message).toBe('WebSocket command failed')
      expect(safe.stack).not.toMatch(/private|secret/)
      expect(safe.stack).toContain('sanitizeServerException')
    }
  })
})
