import { timingSafeEqual } from 'crypto'
import { adminDb } from '@/lib/feeds'
import { syncProducts } from '@/lib/sync'
import { regenerateFeedCache } from '@/lib/feedCache'
import { clientMessage } from '@/lib/errors'
import {
  isAutoSyncDue,
  isAutoSyncFrequency,
  lastScheduledSlot,
  type AutoSyncFrequency,
} from '@/lib/syncSchedule'

// Scheduled product sync. A GitHub Actions workflow calls this every 5 minutes
// (.github/workflows/cron-sync.yml — Vercel Hobby only allows daily crons);
// each call syncs the feeds whose own schedule (Settings → Automatic sync) is
// due. The cron only ticks — the per-feed schedule decides.
//
// Read-only towards Shopify: it runs the exact same syncProducts() as the Sync
// button.

// Hobby-plan ceiling.
export const maxDuration = 300

// Stop STARTING new syncs after this long, so the one in flight can finish
// inside maxDuration. Feeds left over are picked up by the next tick.
const START_BUDGET_MS = 2 * 60 * 1000

type FeedScheduleRow = {
  id: string
  auto_sync_frequency: string
  auto_sync_time: string
  last_auto_sync_at: string | null
}

// The caller sends `Authorization: Bearer <CRON_SECRET>`. Constant-time compare,
// and fail closed when the secret isn't configured.
function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  return got.length === want.length && timingSafeEqual(got, want)
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const t0 = Date.now()
  const now = new Date()
  const db = adminDb()

  const { data, error } = await db
    .from('feeds')
    .select('id, auto_sync_frequency, auto_sync_time, last_auto_sync_at')
    .neq('auto_sync_frequency', 'off')
  if (error) {
    console.error('[cron/sync] could not load feed schedules:', error)
    return Response.json({ error: 'Internal Server Error' }, { status: 500 })
  }

  // Longest-waiting first, so a backlog can't starve the same feed every tick.
  const due = ((data ?? []) as FeedScheduleRow[])
    .filter(
      (f) =>
        isAutoSyncFrequency(f.auto_sync_frequency) &&
        isAutoSyncDue(now, f.auto_sync_frequency, f.auto_sync_time, f.last_auto_sync_at)
    )
    .sort((a, b) => (a.last_auto_sync_at ?? '').localeCompare(b.last_auto_sync_at ?? ''))

  const results: { feedId: string; status: 'ok' | 'error' | 'skipped' }[] = []

  for (const feed of due) {
    if (Date.now() - t0 > START_BUDGET_MS) break

    // Claim the feed before syncing. The condition repeats the due-check in
    // SQL, so if an overlapping tick already claimed it this updates nothing.
    const slot = lastScheduledSlot(now, feed.auto_sync_frequency as AutoSyncFrequency, feed.auto_sync_time)
    if (!slot) continue
    const { data: claimed } = await db
      .from('feeds')
      .update({
        last_auto_sync_at: new Date().toISOString(),
        last_auto_sync_status: 'running',
        last_auto_sync_error: null,
      })
      .eq('id', feed.id)
      .or(`last_auto_sync_at.is.null,last_auto_sync_at.lt."${slot.toISOString()}"`)
      .select('id')
    if (!claimed?.length) {
      results.push({ feedId: feed.id, status: 'skipped' })
      continue
    }

    try {
      await syncProducts(feed.id)

      // Refresh the served XML so Google picks up the new data on its next
      // fetch, instead of a cache that can be up to 6 hours old. Skipped for
      // feeds with AI mappings: generation calls the model per product, and an
      // hourly schedule would multiply that cost — those feeds keep the
      // regular cache expiry.
      const { count: aiMappings } = await db
        .from('feed_mappings')
        .select('google_field', { count: 'exact', head: true })
        .eq('feed_id', feed.id)
        .eq('mapping_type', 'AI')
      if (!aiMappings) await regenerateFeedCache(feed.id)

      await db
        .from('feeds')
        .update({ last_auto_sync_status: 'ok', last_auto_sync_error: null })
        .eq('id', feed.id)
      results.push({ feedId: feed.id, status: 'ok' })
    } catch (err) {
      // clientMessage logs the raw error and keeps only a user-safe message —
      // this one is shown on the settings page.
      await db
        .from('feeds')
        .update({
          last_auto_sync_status: 'error',
          last_auto_sync_error: clientMessage(err, `cron/sync feed ${feed.id}`),
        })
        .eq('id', feed.id)
      results.push({ feedId: feed.id, status: 'error' })
    }
  }

  return Response.json({
    due: due.length,
    processed: results,
    durationMs: Date.now() - t0,
  })
}
