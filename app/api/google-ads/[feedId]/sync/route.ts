import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { syncGoogleAdsMetrics } from '@/lib/googleAdsSync'
import { enforceRateLimit } from '@/lib/rateLimit'
import { errorResponse } from '@/lib/errors'

// POST — manual "refresh now" for a feed's Google Ads metrics.
//
// Rate-limited because the quota at stake is external and shared across every
// client account on the same developer token — see lib/rateLimit.ts. The
// scheduled daily sync does not go through this route.
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

    await enforceRateLimit(user.id, 'google_ads_sync')

    const body = (await req.json().catch(() => ({}))) as { days?: number }
    const result = await syncGoogleAdsMetrics(adminDb(), feedId, { days: body.days })

    return NextResponse.json({ ok: true, result })
  } catch (err) {
    return errorResponse(err, 'POST /api/google-ads/[feedId]/sync')
  }
}
