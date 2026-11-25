import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { countAndStore } from '@/lib/feedCounts'

// LAG 2 endpoint for the feed overview page. countFilteredProducts paginates
// through the products table and applies the feed's filters in JS — too slow
// to block the server-rendered overview, so it lives here instead.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return Response.json({ error: 'Feed not found' }, { status: 404 })

  try {
    const counts = await countAndStore(feedId)
    const excluded = Math.max(0, counts.total - counts.included)
    return Response.json({
      total: counts.total,
      included: counts.included,
      excluded,
    })
  } catch (err) {
    return errorResponse(err, 'GET /api/feeds/[feedId]/counts')
  }
}
