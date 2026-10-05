// Exercise same-millisecond rate-limit entries even when ambient randomness
// repeats. Game decisions must use CAB_RNG_SEED; uniqueness must use crypto.
Date.now = () => Number(process.env.CAB_TEST_NOW)
Math.random = () => 0
