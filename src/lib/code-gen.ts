// Client-safe room-code helpers. The crypto-backed generator lives in
// code-gen.server.ts so Node's `crypto` never reaches the client bundle.

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function formatRoomCode(raw: string): string {
  return `${raw.slice(0, 3)}-${raw.slice(3)}`
}

export function normalizeRoomCode(input: string): string {
  return input.replace(/[-\s]/g, '').toUpperCase()
}
