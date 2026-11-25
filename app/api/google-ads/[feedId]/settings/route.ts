import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { saveFeedSettings, getConnection, getFeedSettings } from '@/lib/feedGoogleAds'
import { logActivity } from '@/lib/activity'
import { syncGoogleAdsMetrics } from '@/lib/googleAdsSync'
import { normalizeCustomerId } from '@/lib/googleAds'
import { enforceRateLimit } from '@/lib/rateLimit'
import { errorResponse } from '@/lib/errors'

type Body = {
  customerId?: string
  customerName?: string | null
  currencyCode?: string | null
  loginCustomerId?: string | null
  feedLabel?: string | null
  /** Summed sets — see ActionChoice in lib/googleAdsAnalytics.ts. */
  roasConversionActions?: string[] | null
  poasConversionActions?: string[] | null
  syncWindowDays?: number
  /** Run the first sync immediately after saving. */
  syncNow?: boolean
}

// Deduped and emptied of blanks. Duplicates would double-count an action against
// itself — the one kind of double counting that is never intentional.
function cleanActions(v: string[] | null | undefined): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((a) => (typeof a === 'string' ? a.trim() : '')).filter(Boolean))]
}

// POST — save a feed's Google Ads setup, and optionally pull data straight away.
//
// The first sync runs inline rather than being left to the nightly schedule:
// finishing setup and then seeing an empty table until tomorrow reads as a
// broken connection.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  try {
    const { feedId } = await params

    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await getSessionUser(supabase)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const feed = await getOwnedFeed(user.id, feedId)
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as Body
    const db = adminDb()

    const connection = await getConnection(db, feed.account_id)
    if (!connection) {
      return NextResponse.json(
        { error: 'There is no Google Ads connection. Connect first.' },
        { status: 400 }
      )
    }

    // The manager that reaches the chosen account is discovered by the picker and
    // stored on the CONNECTION, since login-customer-id is a property of how the
    // grant reaches accounts, not of this feed.
    if (body.loginCustomerId) {
      await db
        .from('google_ads_connections')
        .update({
          login_customer_id: normalizeCustomerId(body.loginCustomerId),
          updated_at: new Date().toISOString(),
        })
        .eq('id', connection.id)
    }

    const prev = await getFeedSettings(db, feedId)
    const settings = await saveFeedSettings(db, feedId, {
      connection_id: connection.id,
      customer_id: body.customerId ? normalizeCustomerId(body.customerId) : null,
      customer_name: body.customerName ?? null,
      currency_code: body.currencyCode ?? null,
      feed_label: body.feedLabel?.trim() || null,
      roas_conversion_actions: cleanActions(body.roasConversionActions),
      poas_conversion_actions: cleanActions(body.poasConversionActions),
      ...(body.syncWindowDays ? { sync_window_days: body.syncWindowDays } : {}),
    })

    // What changed, as the user sees it: account, feed label, the two goals.
    const acct = (s: { customer_name: string | null; customer_id: string | null } | null) =>
      s?.customer_id ? (s.customer_name ?? s.customer_id) : null
    const list = (a: string[] | null | undefined) => (a?.length ? a.join(' + ') : null)
    const changes: { action: string; before: string | null; after: string | null }[] = [
      { action: 'Google Ads-konto ændret', before: acct(prev), after: acct(settings) },
      { action: 'Feed label ændret', before: prev?.feed_label ?? null, after: settings.feed_label },
      { action: 'Mål for omsætning ændret', before: list(prev?.roas_conversion_actions), after: list(settings.roas_conversion_actions) },
      { action: 'Mål for profit ændret', before: list(prev?.poas_conversion_actions), after: list(settings.poas_conversion_actions) },
    ]
    for (const c of changes) {
      if (c.before !== c.after) await logActivity(db, { user, feedId, area: 'Settings', ...c })
    }

    if (!body.syncNow) return NextResponse.json({ ok: true, settings })

    await enforceRateLimit(user.id, 'google_ads_sync')
    try {
      const result = await syncGoogleAdsMetrics(db, feedId)
      return NextResponse.json({ ok: true, settings, result })
    } catch (err) {
      // The settings ARE saved — only the pull failed. Report both so the user
      // isn't told to redo setup that already succeeded.
      return NextResponse.json({
        ok: true,
        settings,
        syncError: err instanceof Error ? err.message : 'Sync failed',
      })
    }
  } catch (err) {
    return errorResponse(err, 'POST /api/google-ads/[feedId]/settings')
  }
}
