import seedrandom from 'seedrandom'

let rng = seedrandom(process.env['CAB_RNG_SEED'] ?? undefined)

export function seedRng(seed: string): void {
  rng = seedrandom(seed)
}

export function randomInt(min: number, max: number): number {
  return Math.floor(rng() * (max - min)) + min
}

export function shuffle<T>(array: T[]): T[] {
  const out = [...array]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

export function pick<T>(array: T[]): T {
  if (array.length === 0) throw new Error('pick called on empty array')
  return array[randomInt(0, array.length)]!
}
