import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { SYNC_STATUS_COLUMNS, toSyncStatus } from '@/lib/syncProgress'

// Live state of the feed's product sync, polled by the progress bar every
// ~1.5 s while a sync runs. One indexed single-row read; no Shopify access.
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
    const { data, error } = await adminDb()
      .from('feeds')
      .select(SYNC_STATUS_COLUMNS)
      .eq('id', feedId)
      .single()
    if (error) throw new Error(`sync-status lookup failed: ${error.message}`)
    return Response.json(toSyncStatus(data), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err, 'GET /api/feeds/[feedId]/sync-status')
  }
}
