import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import { getMetafieldNameMap } from '@/lib/metafieldDefinitions'

// Returns the feed's metafield definition names as a "namespace.key" → name
// record (e.g. "custom._rgang" → "Årgang"), so client views can show readable
// labels instead of Shopify's mangled keys. Lightweight: this only resolves the
// (cached) definition names and does NOT scan product_metafields — unlike
// /api/mapping/metafields, which also needs per-key product counts. Best-effort:
// an empty object on any failure, callers fall back to the raw key.
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const feedId = new URL(req.url).searchParams.get('feedId')
  if (!feedId) return Response.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return Response.json({ error: 'Feed not found' }, { status: 404 })

  const nameMap = await getMetafieldNameMap(feedId)
  return Response.json({ names: Object.fromEntries(nameMap) })
}
