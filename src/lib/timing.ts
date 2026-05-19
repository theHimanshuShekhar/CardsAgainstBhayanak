export const DEAL_MS = 550
export const FADE_IN_MS = 400
export const REVEAL_STAGGER = 700
// Server-driven beat between a round resolving (round_won/round_ranked +
// round_end, winner highlighted) and the next round_started, so players
// can see who won and the winning card(s). Server-controlled per the
// "clients never run their own phase timers" invariant; the engine reads
// CAB_ROUND_RESULT_PAUSE_MS to shrink this for E2E.
export const ROUND_RESULT_PAUSE_MS = 4000
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
