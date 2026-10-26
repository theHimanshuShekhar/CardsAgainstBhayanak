// Every card-content surface uses this marker, including public statistics.
// Keep presentation classes separate so changing a layout cannot unmask text.
export const CARD_CONTENT_PRIVACY_PROPS = { 'data-ph-no-capture': true } as const

export const SESSION_RECORDING_PRIVACY = {
  maskAllInputs: true,
  maskTextSelector: '[data-ph-no-capture], .card-text, .card-back-mark',
} as const
