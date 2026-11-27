import { createHash } from 'crypto'
import { adminDb } from '@/lib/feeds'
import { AppError } from '@/lib/errors'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ── Tunable limits (per user) ────────────────────────────────────────────────
export const RATE_LIMITS = {
  // Frequency caps (per hour):
  ai_suggest:        { limit: 30, windowMs: HOUR }, // AI mapping suggestions
  workshop_generate: { limit: 60, windowMs: HOUR }, // workshop rounds + previews
  shopify_sync:      { limit: 20, windowMs: HOUR }, // full product sync
  feed_regenerate:   { limit: 30, windowMs: HOUR }, // force feed XML rebuild
  shopify_scope_check: { limit: 60, windowMs: HOUR }, // read granted scopes (project page)
  google_ads_sync:   { limit: 12, windowMs: HOUR },
  account_invite:    { limit: 30, windowMs: HOUR }, // invites + new invite links (Agency users)
  signup:            { limit: 5, windowMs: HOUR },  // per IP (see ipRateKey), not per user
  signup_email:      { limit: 3, windowMs: DAY },   // per email address (see emailRateKey): signup emails sent
  billing_session:   { limit: 20, windowMs: HOUR }, // Stripe Checkout / portal sessions
  access_request:    { limit: 10, windowMs: HOUR }, // agency enters a client's access code (anti-guessing)
  admin_action:      { limit: 120, windowMs: HOUR }, // platform admin changes
  // Daily volume budget (per day): max products sent to the AI optimiser. The
  // catalogue is ~2263 products, so 20000/day allows running the whole catalogue
  // several times while iterating on instructions, while still capping a runaway.
  optimize_products_daily: { limit: 20000, windowMs: DAY },
} as const

export type RateLimitKind = keyof typeof RATE_LIMITS

// Thrown when a limit is hit. Extends AppError so the message is client-safe
// (and carries HTTP 429 for API routes).
export class RateLimitError extends AppError {
  constructor(kind: RateLimitKind) {
    super('Too many requests. Wait a moment and try again.', 429)
    this.name = 'RateLimitError'
    this.kind = kind
  }
  kind: RateLimitKind
}

// Aligns `now` to the current fixed window so all calls in the same hour/day
// share one counter row.
function windowStart(windowMs: number): string {
  return new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString()
}

// Enforces a limit for `userId`. `amount` defaults to 1 (frequency); pass the
// batch size for the volume budget. Resolves silently when allowed; throws
// RateLimitError when the limit would be exceeded.
// `failClosed`: refuse when the limiter itself is unavailable, for limits that
// guard against abuse by strangers (signup) rather than a user's own load.
export async function enforceRateLimit(
  userId: string,
  kind: RateLimitKind,
  amount = 1,
  opts: { failClosed?: boolean } = {}
): Promise<void> {
  const cfg = RATE_LIMITS[kind]
  const { data, error } = await adminDb().rpc('increment_rate_limit', {
    p_user_id: userId,
    p_kind: kind,
    p_window_start: windowStart(cfg.windowMs),
    p_amount: amount,
    p_limit: cfg.limit,
  })
  if (error) {
    if (opts.failClosed) {
      console.error(`[rateLimit] limiter unavailable for ${kind}, refusing:`, error.message)
      throw new RateLimitError(kind)
    }
    // Fail-open (e.g. migration 029 not applied yet) — log, don't block.
    console.error(`[rateLimit] limiter unavailable for ${kind}, allowing:`, error.message)
    return
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row && row.allowed === false) {
    throw new RateLimitError(kind)
  }
}

// A stable uuid-shaped key, so limits on signed-out actions (signup) can use
// the same per-"user" counter table. Only a hash is stored.
function uuidKey(value: string): string {
  const h = createHash('sha256').update(value).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// An IP address's key. IPv6 counts per /64 network: one connection usually
// has a whole /64, so per-address keys would be free to rotate.
export function ipRateKey(ip: string): string {
  // An IPv4 address written as IPv6 ("::ffff:1.2.3.4") counts as the IPv4.
  const v4 = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  return uuidKey(`ip:${v4 ?? (ip.includes(':') ? ipv6Prefix64(ip) : ip)}`)
}

// An email address's key (lower-cased), for limits per recipient.
export function emailRateKey(email: string): string {
  return uuidKey(`email:${email.trim().toLowerCase()}`)
}

// The /64 network of an IPv6 address: its first four groups, with "::"
// expanded first ("2001:db8::1" → "2001:db8:0:0::/64").
export function ipv6Prefix64(ip: string): string {
  const addr = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  const [head, tail] = addr.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const groups = tail !== undefined ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}
