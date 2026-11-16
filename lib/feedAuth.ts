// Encrypted storage of a feed-URL project's HTTP Basic Auth login.
//
// Same scheme as the Shopify token (lib/crypto.ts, AES-256-GCM with
// TOKEN_ENCRYPTION_KEY): the plaintext JSON {username, password} lives only
// server-side, at fetch time. Never send it to the client or log it.

import { encryptToken, decryptToken } from '@/lib/crypto'
import type { FeedAuth } from '@/lib/feedUrlSource'

export type FeedAuthColumns = {
  feed_auth_ciphertext: string | null
  feed_auth_iv: string | null
  feed_auth_tag: string | null
}

export const NO_FEED_AUTH: FeedAuthColumns = {
  feed_auth_ciphertext: null,
  feed_auth_iv: null,
  feed_auth_tag: null,
}

export function encryptFeedAuth(auth: FeedAuth): FeedAuthColumns {
  const enc = encryptToken(JSON.stringify({ username: auth.username, password: auth.password }))
  return { feed_auth_ciphertext: enc.ciphertext, feed_auth_iv: enc.iv, feed_auth_tag: enc.tag }
}

// Returns the stored login, or null when the project has none.
export function decryptFeedAuth(cols: Partial<FeedAuthColumns> | null | undefined): FeedAuth | null {
  if (!cols?.feed_auth_ciphertext || !cols.feed_auth_iv || !cols.feed_auth_tag) return null
  const parsed = JSON.parse(
    decryptToken({ ciphertext: cols.feed_auth_ciphertext, iv: cols.feed_auth_iv, tag: cols.feed_auth_tag })
  ) as Partial<FeedAuth>
  return { username: parsed.username ?? '', password: parsed.password ?? '' }
}
