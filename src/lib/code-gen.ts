import { randomInt as cryptoRandomInt } from 'crypto'

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const ALPHABET = ROOM_CODE_ALPHABET

export function generateRoomCode(): string {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += ALPHABET[cryptoRandomInt(0, ALPHABET.length)]
  }
  return code
}

export function formatRoomCode(raw: string): string {
  return `${raw.slice(0, 3)}-${raw.slice(3)}`
}

export function normalizeRoomCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase()
}
