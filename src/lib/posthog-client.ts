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

    // The PostHog toolbar (a PostHog-staff editing/debug overlay) loads from
    // two triggers: a `#__posthog`/`#state` URL hash, or a persisted token in
    // localStorage `_postHogToolbarParams`. Once a project member launches it
    // on a domain, posthog-js persists that token, so the toolbar silently
    // re-appears on every later visit in that browser. posthog-js 1.373.x has
    // no flag to disable only the toolbar (`disable_external_dependency_loading`
    // would also kill session replay + surveys, which the spec requires), so on
    // the deployed site we clear both triggers before init() — init() reads the
    // localStorage trigger — so the toolbar never loads in production. Local dev
    // keeps it for debugging.
    if (location.hostname !== 'localhost') {
      try {
        localStorage.removeItem('_postHogToolbarParams')
        sessionStorage.removeItem('_postHogToolbarParams')
        if (/[#&](__posthog|state)=/.test(location.hash)) {
          history.replaceState(null, '', location.pathname + location.search)
        }
      } catch {
        // storage/history may be unavailable; the toolbar is auth-gated anyway
      }
    }

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
