import { describe, it, expect } from 'vitest'
import { formatRoomCode, normalizeRoomCode, ROOM_CODE_ALPHABET } from './code-gen'
import { generateRoomCode } from './code-gen.server'

describe('code-gen', () => {
  it('alphabet has 31 chars and excludes O, 0, I, 1, L', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(31)
    expect(ROOM_CODE_ALPHABET).not.toMatch(/[O0I1L]/)
  })

  it('generateRoomCode produces 6 uppercase alphanumeric chars from the allowed alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode()
      expect(code).toHaveLength(6)
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch)
    }
  })

  it('formatRoomCode inserts a dash', () => {
    expect(formatRoomCode('B7K9MV')).toBe('B7K-9MV')
  })

  it('normalizeRoomCode strips dashes, spaces, and uppercases', () => {
    expect(normalizeRoomCode('b7k-9mv')).toBe('B7K9MV')
    expect(normalizeRoomCode('B7K 9MV')).toBe('B7K9MV')
    expect(normalizeRoomCode('B7K9MV')).toBe('B7K9MV')
  })
})
