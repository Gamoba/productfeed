import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { saveFeedSettings, getConnection } from '@/lib/feedGoogleAds'
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
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const feed = await getOwnedFeed(user.id, feedId)
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as Body
    const db = adminDb()

    const connection = await getConnection(db, user.id)
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
