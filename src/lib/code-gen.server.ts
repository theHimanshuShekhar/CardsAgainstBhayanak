import { randomInt as cryptoRandomInt } from 'crypto'
import { ROOM_CODE_ALPHABET } from './code-gen'

// Crypto-strength room-code generation (per spec § Randomness — room
// codes use `crypto` directly, never the seedable RNG wrapper).
export function generateRoomCode(): string {
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_ALPHABET[cryptoRandomInt(0, ROOM_CODE_ALPHABET.length)]
  }
  return code
}
