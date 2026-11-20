import { isCronAuthorized } from '@/lib/cronAuth'
import { adminDb } from '@/lib/feeds'
import { runDueOrderSyncs } from '@/lib/orderSyncSchedule'

// Scheduled Shopify order-archive sync. Called by the same GitHub Actions tick
// as /api/cron/sync (.github/workflows/cron-sync.yml); syncs each Shopify
// project whose order sync is older than ORDER_SYNC_INTERVAL_MS. See
// lib/orderSyncSchedule.ts for why this must never lapse.
//
// Read-only towards Shopify.

// Hobby-plan ceiling, as cron/sync.
export const maxDuration = 300

// Stop STARTING new projects after this long; the one in flight finishes
// inside maxDuration. A first-ever run reads 60 days of orders (~45 s for
// BWH); later runs are incremental and take seconds.
const START_BUDGET_MS = 2 * 60 * 1000

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const t0 = Date.now()
  try {
    const result = await runDueOrderSyncs(adminDb(), { startBudgetMs: START_BUDGET_MS })
    return Response.json({ ...result, durationMs: Date.now() - t0 })
  } catch (err) {
    console.error('[cron/orders] failed:', err)
    return Response.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
