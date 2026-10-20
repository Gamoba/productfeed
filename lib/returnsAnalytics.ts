// Returns and refunds, expressed as something the ads numbers can be read
// against.
//
// ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
// It does not change roas, poas, or any existing metric. Nothing in
// lib/googleAdsAnalytics.ts or lib/googleAdsBuckets.ts reads this file. Gross
// ROAS stays exactly what Google reported, and the net figure sits NEXT to it.
// That is deliberate: the two disagreeing in public is the entire finding, and
// a single silently-corrected number would hide it while also breaking every
// comparison against the Google Ads UI.
//
// ── THE TWO NUMBERS, AND WHY THEY ARE NOT THE SAME NUMBER ──────────────────
//   RATE — a property of the variant, measured over a matured cohort of past
//     orders. Answers "what fraction of this variant's revenue comes back?"
//     and is what corrects ROAS for any window, including windows too short to
//     contain a return cycle.
//
//   MONEY IN WINDOW — refunds that actually left in the period being viewed,
//     whatever the age of the order. Answers "how much came back?". It is a
//     cash fact, never a rate: most of it belongs to orders placed before the
//     window opened, so dividing it by the window's revenue would be
//     meaningless.
//
// ── ATTRIBUTION: DELIBERATELY NOT ATTEMPTED ────────────────────────────────
// Shopify cannot reliably say which orders came from Google Ads, so this does
// not pretend to know. The rate is measured across ALL of the market's orders
// for that variant and applied as a correction factor to the ads revenue.
// Return behaviour is driven by the product, not by the traffic source — and a
// factor measured on the full order set has a far larger sample than one
// restricted to a channel we would only be guessing at anyway.
//
// ── A RATE FROM THREE ORDERS IS NOT A RATE ─────────────────────────────────
// The same rule as unentered costs (lib/variantCosts.ts) and untested products
// (lib/googleAdsBuckets.ts): below the minimum sample, the rate is null, not a
// number. One return out of three units is 33% and means nothing, and a "worst
// returns" list sorted on noise is worse than no list.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'

/**
 * How long a return takes to show up.
 *
 * Orders newer than this are excluded from the cohort entirely: their return
 * window is still open, so counting them would dilute every rate toward zero
 * exactly as a product ramps up. 30 days covers the common 14–30 day policy
 * plus shipping time back.
 */
export const DEFAULT_MATURITY_DAYS = 30

/**
 * How much matured history the rate is measured over.
 *
 * Capped by what the archive actually holds. Under `read_orders` alone, a
 * freshly-synced project has at most ~59 days of orders, of which only the
 * matured part counts — so early on this is aspirational and the reported
 * sample size is what tells the truth about it.
 */
export const DEFAULT_COHORT_DAYS = 180

/**
 * Units that must have sold before a rate is reported at all.
 *
 * 20 is the point where one extra return moves the rate by 5 points rather
 * than by 33. Below it the honest answer is "not enough data", which is what
 * null says.
 */
export const MIN_SAMPLE_UNITS = 20

type SummaryRow = {
  product_ref: string | null
  variant_ref: string | null
  cohort_orders: number
  cohort_units_sold: number
  cohort_gross_value: number
  cohort_units_returned: number
  cohort_returned_value: number
  cohort_other_refunded_value: number
  window_units_returned: number
  window_returned_value: number
  window_other_refunded_value: number
}

/** Raw sums for one entity, before any judgement about sample size. */
export type ReturnTotals = {
  cohortOrders: number
  cohortUnitsSold: number
  cohortGrossValue: number
  cohortUnitsReturned: number
  cohortReturnedValue: number
  cohortOtherRefundedValue: number
  windowUnitsReturned: number
  windowReturnedValue: number
  windowOtherRefundedValue: number
}

export type ReturnDerived = {
  /**
   * Returned value ÷ gross value over the matured cohort. Null below the
   * minimum sample — never 0.
   *
   * Value, not units: a customer who returns the cheap variant and keeps the
   * expensive one has a 50% unit return rate and a much smaller revenue one,
   * and it is revenue that ROAS is made of.
   */
  returnRate: number | null
  /** Units returned ÷ units sold. Reported alongside because it is what an operator recognises. */
  unitReturnRate: number | null
  /** Everything refunded in the viewed window, return-driven or not. */
  refundedInWindow: number
  /** How many units the rate rests on, so a surface can show its own weakness. */
  sampleUnits: number
  /** False when the sample is too thin for returnRate to exist. */
  hasRate: boolean
}

export type ReturnRow = ReturnTotals &
  ReturnDerived & {
    productRef: string | null
    variantRef: string | null
  }

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function deriveReturns(t: ReturnTotals): ReturnDerived {
  const enough = t.cohortUnitsSold >= MIN_SAMPLE_UNITS
  return {
    returnRate: enough && t.cohortGrossValue > 0 ? t.cohortReturnedValue / t.cohortGrossValue : null,
    unitReturnRate: enough && t.cohortUnitsSold > 0 ? t.cohortUnitsReturned / t.cohortUnitsSold : null,
    refundedInWindow: t.windowReturnedValue + t.windowOtherRefundedValue,
    sampleUnits: t.cohortUnitsSold,
    hasRate: enough && t.cohortGrossValue > 0,
  }
}

const EMPTY_TOTALS: ReturnTotals = {
  cohortOrders: 0,
  cohortUnitsSold: 0,
  cohortGrossValue: 0,
  cohortUnitsReturned: 0,
  cohortReturnedValue: 0,
  cohortOtherRefundedValue: 0,
  windowUnitsReturned: 0,
  windowReturnedValue: 0,
  windowOtherRefundedValue: 0,
}

function addTotals(a: ReturnTotals, b: ReturnTotals): ReturnTotals {
  return {
    cohortOrders: a.cohortOrders + b.cohortOrders,
    cohortUnitsSold: a.cohortUnitsSold + b.cohortUnitsSold,
    cohortGrossValue: a.cohortGrossValue + b.cohortGrossValue,
    cohortUnitsReturned: a.cohortUnitsReturned + b.cohortUnitsReturned,
    cohortReturnedValue: a.cohortReturnedValue + b.cohortReturnedValue,
    cohortOtherRefundedValue: a.cohortOtherRefundedValue + b.cohortOtherRefundedValue,
    windowUnitsReturned: a.windowUnitsReturned + b.windowUnitsReturned,
    windowReturnedValue: a.windowReturnedValue + b.windowReturnedValue,
    windowOtherRefundedValue: a.windowOtherRefundedValue + b.windowOtherRefundedValue,
  }
}

export type ReturnsQuery = {
  /** The feed's market. Null reads every country in the archive. */
  country: string | null
  /** Window being viewed, as the ads pages express it: YYYY-MM-DD, inclusive. */
  from: string
  to: string
  maturityDays?: number
  cohortDays?: number
}

export type ReturnsResult = {
  /** Keyed by variant_ref. Variants deleted from Shopify keep their sales history under a null ref, which is dropped here. */
  byVariant: Map<string, ReturnRow>
  /** Keyed by product_ref, summed from the same rows so the grains cannot disagree. */
  byProduct: Map<string, ReturnRow>
  /**
   * The whole market, as one row. Context for a product whose own sample is
   * too thin — shown as a comparison, never substituted for a missing rate.
   */
  overall: ReturnRow
  /** The matured range the rate was measured over, for the UI to state plainly. */
  cohortFrom: string
  cohortTo: string
}

/**
 * Per-variant and per-product returns for one market and one window.
 *
 * The cohort is derived here rather than passed in, so every caller measures
 * the rate the same way and no page can quietly pick a flattering maturity.
 */
export async function getReturns(
  db: SupabaseClient,
  projectId: string,
  q: ReturnsQuery
): Promise<ReturnsResult> {
  const maturityDays = q.maturityDays ?? DEFAULT_MATURITY_DAYS
  const cohortDays = q.cohortDays ?? DEFAULT_COHORT_DAYS

  const cohortTo = new Date(Date.now() - maturityDays * 86_400_000)
  const cohortFrom = new Date(cohortTo.getTime() - cohortDays * 86_400_000)

  // The window arrives as inclusive dates; the SQL is half-open, so the end
  // becomes the start of the following day rather than 23:59, which would drop
  // refunds in the last second of the range.
  const windowFrom = `${q.from}T00:00:00.000Z`
  const windowTo = new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + 86_400_000).toISOString()

  const { data, error } = await db.rpc('shopify_returns_variant_summary', {
    p_project_id: projectId,
    p_country: q.country,
    p_cohort_from: cohortFrom.toISOString(),
    p_cohort_to: cohortTo.toISOString(),
    p_window_from: windowFrom,
    p_window_to: windowTo,
  })
  if (error) dbError('getReturns', error)

  const byVariant = new Map<string, ReturnRow>()
  const productTotals = new Map<string, ReturnTotals>()
  let overallTotals = EMPTY_TOTALS

  for (const r of (data ?? []) as SummaryRow[]) {
    const totals: ReturnTotals = {
      cohortOrders: num(r.cohort_orders),
      cohortUnitsSold: num(r.cohort_units_sold),
      cohortGrossValue: num(r.cohort_gross_value),
      cohortUnitsReturned: num(r.cohort_units_returned),
      cohortReturnedValue: num(r.cohort_returned_value),
      cohortOtherRefundedValue: num(r.cohort_other_refunded_value),
      windowUnitsReturned: num(r.window_units_returned),
      windowReturnedValue: num(r.window_returned_value),
      windowOtherRefundedValue: num(r.window_other_refunded_value),
    }

    const productRef = r.product_ref ?? null
    const variantRef = r.variant_ref ?? null

    if (variantRef) {
      byVariant.set(variantRef, {
        productRef,
        variantRef,
        ...totals,
        ...deriveReturns(totals),
      })
    }

    // The product rollup keeps variant-less rows (deleted variants), because
    // that money was still spent and still came back.
    if (productRef) {
      productTotals.set(productRef, addTotals(productTotals.get(productRef) ?? EMPTY_TOTALS, totals))
    }
    overallTotals = addTotals(overallTotals, totals)
  }

  const byProduct = new Map<string, ReturnRow>()
  for (const [productRef, totals] of productTotals) {
    byProduct.set(productRef, {
      productRef,
      variantRef: null,
      ...totals,
      ...deriveReturns(totals),
    })
  }

  return {
    byVariant,
    byProduct,
    overall: {
      productRef: null,
      variantRef: null,
      ...overallTotals,
      ...deriveReturns(overallTotals),
    },
    cohortFrom: cohortFrom.toISOString().slice(0, 10),
    cohortTo: cohortTo.toISOString().slice(0, 10),
  }
}

export type FeedReturns = ReturnsResult & {
  /** The market this was measured in, or null when the feed declares none. */
  country: string | null
  /** Null when the feed has no project, i.e. no Shopify connection at all. */
  projectId: string | null
}

/** Empty result, for feeds with no project or no archive yet. */
function emptyReturns(country: string | null, projectId: string | null): FeedReturns {
  const derived = deriveReturns(EMPTY_TOTALS)
  return {
    byVariant: new Map(),
    byProduct: new Map(),
    overall: { productRef: null, variantRef: null, ...EMPTY_TOTALS, ...derived },
    cohortFrom: '',
    cohortTo: '',
    country,
    projectId,
  }
}

/**
 * Returns for one feed, resolved through its project and its market.
 *
 * The market resolution lives here, once, so the product table and the variant
 * drill-down cannot end up measuring different countries — which would show a
 * product's variants failing to add up to the product.
 */
export async function getReturnsForFeed(
  db: SupabaseClient,
  feedId: string,
  window: { from: string; to: string }
): Promise<FeedReturns> {
  const [{ data: feedRow }, { data: shopRow }] = await Promise.all([
    db.from('feeds').select('project_id').eq('id', feedId).maybeSingle(),
    db.from('shop_settings').select('selected_country').eq('feed_id', feedId).maybeSingle(),
  ])

  const projectId = (feedRow as { project_id: string | null } | null)?.project_id ?? null
  const country =
    (shopRow as { selected_country: string | null } | null)?.selected_country ?? null

  if (!projectId) return emptyReturns(country, null)

  const result = await getReturns(db, projectId, { country, from: window.from, to: window.to })
  return { ...result, country, projectId }
}

// ── Applying a rate to the ads numbers ──────────────────────────────────────

export type NetPerformance = {
  /** roas × (1 − returnRate). Null when either input is null. */
  netRoas: number | null
  /** poas × (1 − returnRate). Null when either input is null. */
  netPoas: number | null
  /**
   * Revenue the rate implies never stuck, over the window's reported revenue.
   * An ESTIMATE from a measured rate — not the same thing as
   * `refundedInWindow`, which is money observed leaving. Both are shown
   * because they answer different questions and will not match.
   */
  estimatedReturnedRevenue: number | null
  /** Gross profit after ad spend, with the same correction applied to the profit side. */
  netProfitAfterAdSpend: number | null
}

export const NO_NET: NetPerformance = {
  netRoas: null,
  netPoas: null,
  estimatedReturnedRevenue: null,
  netProfitAfterAdSpend: null,
}

/**
 * Applies a measured return rate to one entity's ads metrics.
 *
 * Everything is null when the rate is null. A missing rate must not silently
 * become a net figure equal to the gross one — that would read as "this
 * product has no returns", which is the opposite of "we do not know yet".
 */
export function applyReturnRate(
  metrics: {
    roas: number | null
    poas: number | null
    roas_value: number
    poas_value: number
    cost: number
  },
  returns: ReturnDerived | undefined
): NetPerformance {
  const rate = returns?.returnRate
  if (rate === null || rate === undefined) return NO_NET

  const kept = 1 - rate
  return {
    netRoas: metrics.roas === null ? null : metrics.roas * kept,
    netPoas: metrics.poas === null ? null : metrics.poas * kept,
    estimatedReturnedRevenue: metrics.roas_value * rate,
    // The profit side takes the same haircut: a returned unit gives back its
    // revenue and its margin together. The ad spend that bought it does not
    // come back at all, which is why cost is subtracted whole.
    netProfitAfterAdSpend: metrics.poas_value * kept - metrics.cost,
  }
}
