// Per-user rate limiting + daily volume budgets, backed by Supabase (migration
// 029) so the counters are shared across serverless instances on Vercel — an
// in-memory limiter would reset per cold start and protect nothing.
//
// Two shapes, both via one atomic SQL function (increment_rate_limit):
//   - FREQUENCY caps: how often a single user may invoke an expensive endpoint
//     (amount = 1, hourly window). Applied to the one-shot calls.
//   - VOLUME budget: how many products a user may AI-optimise per day
//     (amount = batch size, daily window). Applied to the product-processing
//     functions so it accumulates correctly across the chunked run.
//
// Fail-open: if the limiter itself errors (e.g. the migration hasn't run yet),
// we log and ALLOW rather than break the app. The closed-signup gate already
// bounds who can reach these endpoints; availability wins over strict counting.

import { adminDb } from '@/lib/feeds'
import { AppError } from '@/lib/errors'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ── Tunable limits (per user) ────────────────────────────────────────────────
// Generous for a single legitimate operator; they stop runaway loops, not work.
export const RATE_LIMITS = {
  // Frequency caps (per hour):
  ai_suggest:        { limit: 30, windowMs: HOUR }, // AI mapping suggestions
  workshop_generate: { limit: 60, windowMs: HOUR }, // workshop rounds + previews
  shopify_sync:      { limit: 20, windowMs: HOUR }, // full product sync
  feed_regenerate:   { limit: 30, windowMs: HOUR }, // force feed XML rebuild
  shopify_scope_check: { limit: 60, windowMs: HOUR }, // read granted scopes (project page)
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
    super('For mange forespørgsler — vent lidt og prøv igen.', 429)
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
export async function enforceRateLimit(
  userId: string,
  kind: RateLimitKind,
  amount = 1
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
    // Fail-open (e.g. migration 029 not applied yet) — log, don't block.
    console.error(`[rateLimit] limiter unavailable for ${kind}, allowing:`, error.message)
    return
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row && row.allowed === false) {
    throw new RateLimitError(kind)
  }
}
