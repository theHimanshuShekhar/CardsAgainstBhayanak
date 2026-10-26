// Exercise same-millisecond rate-limit entries even when ambient randomness
// repeats. Game decisions must use CAB_RNG_SEED; uniqueness must use crypto.
Date.now = () => Number(process.env.CAB_TEST_NOW)
Math.random = () => 0

// Keep the copied catalog fixed across replays. Mock only the upstream network
// boundary; the application's HTTP/WebSocket transports use their real code.
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname === 'restagainsthumanity.com') {
    return Promise.reject(new Error('Seeded replay uses its existing fixed card catalog'))
  }
  return originalFetch(input, init)
}
