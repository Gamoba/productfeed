import { randomBytes } from 'crypto'

// A User account's access code (accounts.access_code): what the client gives
// an agency so it can ask for access. 10 characters from an alphabet without
// look-alikes (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function newAccessCode(): string {
  return Array.from(randomBytes(10), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}
