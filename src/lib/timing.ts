export const DEAL_MS = 550
export const FADE_IN_MS = 400
export const REVEAL_STAGGER = 700
export const WINNER_PAUSE = 2600
export const RECONNECT_TOAST = 250
export const GRACE_WINDOW_MS = 30_000
export const KEEPALIVE_INTERVAL_MS = 15_000
export const KEEPALIVE_TIMEOUT_MS = 45_000

export const TIMING = {
  GRACE_WINDOW_MS,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_TIMEOUT_MS,
} as const

export const TIMER_MS: Record<'30s' | '60s' | '90s', number> = {
  '30s': 30_000,
  '60s': 60_000,
  '90s': 90_000,
}
