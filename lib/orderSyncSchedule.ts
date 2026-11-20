import type { SupabaseClient } from '@supabase/supabase-js'
import { syncShopifyOrders } from '@/lib/shopifyOrders'
import { clientMessage } from '@/lib/errors'

// Scheduled order-archive sync (/api/cron/orders).
//
// The app has `read_orders` but not `read_all_orders`: Shopify shows only the
// last 60 days of orders, so an archive that isn't refreshed inside that
// window loses the orders in between FOREVER (lib/shopifyOrders.ts). This is
// what keeps that from depending on someone remembering to run a script.
//
// Every Shopify project, every few hours. After the first run a sync is
// incremental from its watermark — seconds, not minutes — so running well
// inside the 60-day window costs next to nothing and leaves plenty of retries
// if Shopify or the token is down for a while.
//
// Read-only towards Shopify (syncShopifyOrders only queries); writes only the
// order archive tables in our database.

/** A project is due once its last run (ok OR failed) is older than this. */
export const ORDER_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000

type ProjectRow = { id: string; name: string }
type StateRow = { project_id: string; last_run_at: string | null }

export type DueProject = { id: string; name: string; lastRunAt: string | null }

/**
 * Shopify-connected projects whose order sync is due, longest-waiting first
 * (never-run first of all), so one slow project can't starve the others.
 */
export async function dueOrderSyncProjects(db: SupabaseClient, now = new Date()): Promise<DueProject[]> {
  const [{ data: projects, error: pErr }, { data: states, error: sErr }] = await Promise.all([
    db
      .from('projects')
      .select('id, name')
      .eq('source_type', 'shopify')
      .not('shop_url', 'is', null)
      .not('access_token_ciphertext', 'is', null),
    db.from('shopify_order_sync_state').select('project_id, last_run_at'),
  ])
  if (pErr) throw new Error(`order cron: projects lookup failed: ${pErr.message}`)
  if (sErr) throw new Error(`order cron: sync state lookup failed: ${sErr.message}`)

  const lastRun = new Map(((states ?? []) as StateRow[]).map((s) => [s.project_id, s.last_run_at]))
  const cutoff = now.getTime() - ORDER_SYNC_INTERVAL_MS

  return ((projects ?? []) as ProjectRow[])
    .map((p) => ({ id: p.id, name: p.name, lastRunAt: lastRun.get(p.id) ?? null }))
    .filter((p) => p.lastRunAt === null || new Date(p.lastRunAt).getTime() < cutoff)
    .sort((a, b) => (a.lastRunAt ?? '').localeCompare(b.lastRunAt ?? ''))
}

export type OrderCronResult = {
  due: number
  processed: { projectId: string; status: 'ok' | 'error'; orders?: number; error?: string }[]
}

/**
 * Syncs due projects one after another until `startBudgetMs` has passed —
 * then stops STARTING new ones, so the one in flight finishes inside the
 * route's maxDuration. Whatever is left is picked up by the next tick.
 *
 * A failed project is reported and skipped, never fatal for the others; the
 * failure is also recorded on its sync state (last_error) by syncShopifyOrders,
 * and its last_run_at moves, so it is retried after the interval rather than
 * hammered every tick.
 */
export async function runDueOrderSyncs(
  db: SupabaseClient,
  opts: { startBudgetMs: number; now?: Date }
): Promise<OrderCronResult> {
  const t0 = Date.now()
  const due = await dueOrderSyncProjects(db, opts.now)
  const processed: OrderCronResult['processed'] = []

  for (const p of due) {
    if (Date.now() - t0 > opts.startBudgetMs) break
    try {
      const r = await syncShopifyOrders(db, p.id)
      console.log(`[cron/orders] ${p.name}: ${r.orders} orders, ${r.pages} pages, ${r.durationMs}ms`)
      processed.push({ projectId: p.id, status: 'ok', orders: r.orders })
    } catch (err) {
      processed.push({
        projectId: p.id,
        status: 'error',
        error: clientMessage(err, `cron/orders project ${p.id}`),
      })
    }
  }

  return { due: due.length, processed }
}
