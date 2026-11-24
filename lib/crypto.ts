// AES-256-GCM token encryption — see AGENTS.md / projects plan trin 2.
//
// Shopify access tokens are NEVER stored in plaintext. They are encrypted at
// rest with a key that lives in the environment (TOKEN_ENCRYPTION_KEY),
// separate from the database. Decryption happens ONLY server-side, in the
// moment a Shopify call is made — the plaintext token must never reach the
// client.
//
// The key is read lazily (inside the functions) so importing this module never
// throws; a missing/invalid key only errors when encryption/decryption is
// actually attempted.

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
// 96-bit IV is the recommended nonce size for GCM.
const IV_BYTES = 12

export type EncryptedToken = {
  ciphertext: string // base64
  iv: string // base64
  tag: string // base64 (GCM auth tag)
}

function getKey(): Buffer {
  const b64 = process.env.TOKEN_ENCRYPTION_KEY
  if (!b64) {
    throw new Error('TOKEN_ENCRYPTION_KEY is missing from the environment')
  }
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must be 32 bytes base64 (decoded to ${key.length} bytes)`
    )
  }
  return key
}

// Encrypts a plaintext token. A fresh random IV is generated per call, so
// encrypting the same token twice yields different ciphertext — that's expected
// and correct for GCM.
export function encryptToken(plaintext: string): EncryptedToken {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  }
}

// Decrypts a token. Server-side only. Throws if the auth tag doesn't verify
// (tampered ciphertext / wrong key).
export function decryptToken({ ciphertext, iv, tag }: EncryptedToken): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

// UI helper: a non-reversible masked hint for display, e.g. "••••••••cd34".
// Never derives from the decrypted token on the client — compute this
// server-side from the plaintext only when you already have it in hand.
export function maskToken(plaintext: string): string {
  const last4 = plaintext.slice(-4)
  return `${'•'.repeat(8)}${last4}`
}
