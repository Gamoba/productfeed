import { isCronAuthorized } from '@/lib/cronAuth'
import { adminDb } from '@/lib/feeds'
import { measureDueShops } from '@/lib/skuMeasure'
import { chargeExtraSkus } from '@/lib/extraSkus'
import { billingConfigured } from '@/lib/stripe'

// Daily SKU count, and the bill for extra SKUs once a month.
//
// The GitHub Actions workflow calls this with every tick
// (.github/workflows/cron-sync.yml), the same as the other scheduled jobs.
// Both halves decide for themselves whether there is anything to do:
//
//   - Measuring: each shop is counted once a UTC day (shop_sku_usage). Shops
//     already counted today are skipped, so the extra ticks cost two queries.
//     A big install that doesn't fit in one run is finished by the next tick.
//   - Billing: on the first run after a month ends, every paying account is
//     billed for that month's extra SKUs (sku_charges, one row per account and
//     month). Later runs in the month find the row and do nothing.
//
// Read-only towards Shopify: the count comes from the products already synced.

export const maxDuration = 300

// Stop counting after this long, so the run finishes inside maxDuration.
const MEASURE_BUDGET_MS = 3.5 * 60 * 1000

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const t0 = Date.now()
  const db = adminDb()

  let measured: Awaited<ReturnType<typeof measureDueShops>> | null = null
  try {
    measured = await measureDueShops(db, { budgetMs: MEASURE_BUDGET_MS })
  } catch (err) {
    // Billing a finished month matters more than today's count: carry on.
    console.error('[cron/sku-usage] measuring failed:', err)
  }

  // Needs Stripe keys; without them the month is billed on a later run.
  let charged: Awaited<ReturnType<typeof chargeExtraSkus>> = []
  if (billingConfigured()) {
    try {
      charged = await chargeExtraSkus(db)
    } catch (err) {
      console.error('[cron/sku-usage] billing extra SKUs failed:', err)
    }
  }

  return Response.json({
    measured: measured?.measured.length ?? 0,
    failed: measured?.failed ?? [],
    remaining: measured?.remaining ?? null,
    charged: charged
      .filter((c) => c.status !== 'already')
      .map((c) => ({ account: c.accountId, month: c.month, status: c.status, amountCents: c.amountCents, note: c.note })),
    durationMs: Date.now() - t0,
  })
}
