import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { generatePreview } from '@/lib/feedGenerator'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

// LAG 2 endpoint for the preview page. The server-rendered page returns the
// first 20 rows immediately; PreviewClient calls this after mount to load a
// fuller sample (default 100) so the user can inspect more products without
// waiting on the mapping resolution upfront.
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) return Response.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return Response.json({ error: 'Feed not found' }, { status: 404 })

  const limitRaw = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_LIMIT)
    : DEFAULT_LIMIT

  try {
    // count=0: just the rows; the page shows the stored count and recounts
    // through /api/feeds/[feedId]/counts in parallel.
    const data = await generatePreview(feedId, limit, {}, { count: url.searchParams.get('count') !== '0' })
    return Response.json(data)
  } catch (err) {
    return errorResponse(err, 'GET /api/preview')
  }
}
