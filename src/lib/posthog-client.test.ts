import { afterEach, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'
import { initPostHog } from './posthog-client'
import { SESSION_RECORDING_PRIVACY } from './card-privacy'

// Analytics and the runtime config endpoint are external system boundaries.
vi.mock('posthog-js', () => ({ default: { init: vi.fn() } }))

afterEach(() => vi.unstubAllGlobals())

it('initializes the analytics recorder with the privacy settings exercised by DOM captures', async () => {
  vi.stubGlobal('window', {})
  vi.stubGlobal('location', { hostname: 'localhost' })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ posthogKey: 'phc_test', posthogHost: 'https://analytics.example.test' }),
    }),
  )

  await initPostHog()

  expect(posthog.init).toHaveBeenCalledWith(
    'phc_test',
    expect.objectContaining({ session_recording: SESSION_RECORDING_PRIVACY }),
  )
  expect(SESSION_RECORDING_PRIVACY.maskAllInputs).toBe(true)
  expect(SESSION_RECORDING_PRIVACY.maskTextSelector).toContain('[data-ph-no-capture]')
})
