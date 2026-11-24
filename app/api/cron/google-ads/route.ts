import { isCronAuthorized } from '@/lib/cronAuth'
import { adminDb } from '@/lib/feeds'
import { syncGoogleAdsMetrics } from '@/lib/googleAdsSync'
import { clientMessage } from '@/lib/errors'
import { logActivity } from '@/lib/activity'
import {
  isAutoSyncDue,
  isAutoSyncFrequency,
  lastScheduledSlot,
  type AutoSyncFrequency,
} from '@/lib/syncSchedule'

// Scheduled Google Ads performance fetch (Settings → Tidsplan → Hent
// performance). Ticked by the same GitHub Actions workflow as /api/cron/sync;
// each call pulls the connected feeds whose own schedule is due.
//
// Read-only towards Google Ads: it runs the same syncGoogleAdsMetrics() as the
// "Hent tal" button. Schedule columns: migration 054.

export const maxDuration = 300

// Stop STARTING new fetches after this long, so the one in flight can finish
// inside maxDuration. Feeds left over are picked up by the next tick.
const START_BUDGET_MS = 2 * 60 * 1000

type ScheduleRow = {
  feed_id: string
  auto_sync_frequency: string
  auto_sync_time: string
  last_auto_sync_at: string | null
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const t0 = Date.now()
  const now = new Date()
  const db = adminDb()

  // Only feeds that can actually be fetched: an account picked on a connection.
  const { data, error } = await db
    .from('google_ads_feed_settings')
    .select('feed_id, auto_sync_frequency, auto_sync_time, last_auto_sync_at')
    .neq('auto_sync_frequency', 'off')
    .not('customer_id', 'is', null)
    .not('connection_id', 'is', null)
  if (error) {
    console.error('[cron/google-ads] could not load schedules:', error)
    return Response.json({ error: 'Internal Server Error' }, { status: 500 })
  }

  const due = ((data ?? []) as ScheduleRow[])
    .filter(
      (f) =>
        isAutoSyncFrequency(f.auto_sync_frequency) &&
        isAutoSyncDue(now, f.auto_sync_frequency, f.auto_sync_time, f.last_auto_sync_at)
    )
    .sort((a, b) => (a.last_auto_sync_at ?? '').localeCompare(b.last_auto_sync_at ?? ''))

  const results: { feedId: string; status: 'ok' | 'error' | 'skipped' }[] = []

  for (const row of due) {
    if (Date.now() - t0 > START_BUDGET_MS) break

    // Claim first; the condition repeats the due-check so an overlapping tick
    // that already claimed this feed updates nothing. Never touches updated_at
    // (see migration 054).
    const slot = lastScheduledSlot(now, row.auto_sync_frequency as AutoSyncFrequency, row.auto_sync_time)
    if (!slot) continue
    const { data: claimed } = await db
      .from('google_ads_feed_settings')
      .update({
        last_auto_sync_at: new Date().toISOString(),
        last_auto_sync_status: 'running',
        last_auto_sync_error: null,
      })
      .eq('feed_id', row.feed_id)
      .or(`last_auto_sync_at.is.null,last_auto_sync_at.lt."${slot.toISOString()}"`)
      .select('feed_id')
    if (!claimed?.length) {
      results.push({ feedId: row.feed_id, status: 'skipped' })
      continue
    }

    try {
      await syncGoogleAdsMetrics(db, row.feed_id)
      await db
        .from('google_ads_feed_settings')
        .update({ last_auto_sync_status: 'ok', last_auto_sync_error: null })
        .eq('feed_id', row.feed_id)
      results.push({ feedId: row.feed_id, status: 'ok' })
    } catch (err) {
      const message = clientMessage(err, `cron/google-ads feed ${row.feed_id}`)
      await db
        .from('google_ads_feed_settings')
        .update({ last_auto_sync_status: 'error', last_auto_sync_error: message })
        .eq('feed_id', row.feed_id)
      await logActivity(db, { user: null, feedId: row.feed_id, area: 'Performance', action: 'Hentning af Google Ads-tal fejlede', after: message })
      results.push({ feedId: row.feed_id, status: 'error' })
    }
  }

  return Response.json({ due: due.length, processed: results, durationMs: Date.now() - t0 })
}
