import type { ErrorCode } from './types'

// Expected command rejections are safe to return to the requesting socket.
// Unexpected exceptions still follow the handler's sanitized error path.
export class GameCommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GameCommandError'
  }
}
