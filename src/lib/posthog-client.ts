import posthog from 'posthog-js'

let initialized = false

export async function initPostHog(): Promise<void> {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  try {
    const res = await fetch('/api/config')
    if (!res.ok) return
    const cfg: { posthogKey: string | null; posthogHost: string } = await res.json()
    if (!cfg.posthogKey) return
    posthog.init(cfg.posthogKey, {
      api_host: cfg.posthogHost,
      person_profiles: 'identified_only',
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '[data-ph-no-capture], .card-text, .card-back-mark',
      },
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: false,
      loaded: (ph) => {
        if (location.hostname === 'localhost') ph.opt_out_capturing()
      },
    })
  } catch {
    // analytics must not break the app
  }
}

export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  posthog.capture(event, properties)
}

export function identifyAnon(anonId: string, properties?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  posthog.identify(anonId, properties)
}

export function getOrCreateAnonId(): string {
  if (typeof window === 'undefined') return 'ssr'
  let id = localStorage.getItem('cab_anon_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('cab_anon_id', id)
  }
  return id
}
