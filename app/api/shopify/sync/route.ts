import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { syncProducts } from '@/lib/sync'
import { getOwnedFeed } from '@/lib/feeds'
import { enforceRateLimit } from '@/lib/rateLimit'
import { clientMessage, errorResponse } from '@/lib/errors'
import { logActivity } from '@/lib/activity'
import { adminDb } from '@/lib/feeds'
import { formatNumber } from '@/lib/formatDa'

// A full sync of a large catalog (a ~28k-product feed URL takes 30–40 s) must
// not hit the platform default limit. 300 s = Hobby-plan ceiling, as in cron/sync.
export const maxDuration = 300

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) {
    return Response.json({ error: 'feedId is missing' }, { status: 400 })
  }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) {
    return Response.json({ error: 'Feed not found' }, { status: 404 })
  }

  try {
    // Cost/abuse guard: cap full syncs per user (Shopify API load).
    await enforceRateLimit(user.id, 'shopify_sync')
    let result
    try {
      result = await syncProducts(feedId)
    } catch (err) {
      await logActivity(adminDb(), {
        user,
        feedId,
        area: 'Synkronisering',
        action: 'Synkronisering fejlede',
        after: clientMessage(err, 'POST /api/shopify/sync'),
      })
      throw err
    }
    await logActivity(adminDb(), {
      user,
      feedId,
      area: 'Synkronisering',
      action: 'Varer synkroniseret',
      after: `${formatNumber(result.synced)} varer`,
    })
    return Response.json(result)
  } catch (err) {
    return errorResponse(err, 'POST /api/shopify/sync')
  }
}
