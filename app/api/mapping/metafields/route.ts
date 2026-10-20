import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { getMetafieldNameMap } from '@/lib/metafieldDefinitions'

const PAGE_SIZE = 1000

// Returns the unique (namespace, key) metafield pairs for a feed, each with its
// readable definition name when one exists (e.g. "custom._rgang" → "Årgang") so
// the mapping pickers show a legible label, not the mangled key. Backs the
// mapping page's LAG 2 fetch — kept out of the server component so the page
// renders the saved mappings without waiting on this paginated scan, which
// can take seconds for stores with thousands of metafield rows.
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) return Response.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return Response.json({ error: 'Feed not found' }, { status: 404 })

  const db = adminDb()
  const seen = new Set<string>()
  const metafields: { namespace: string; key: string; name?: string }[] = []
  let from = 0

  while (true) {
    const { data, error } = await db
      .from('product_metafields')
      .select('namespace, key')
      .eq('feed_id', feedId)
      .order('namespace')
      .order('key')
      .range(from, from + PAGE_SIZE - 1)

    if (error) {
      return errorResponse(error, 'GET /api/mapping/metafields')
    }
    if (!data || data.length === 0) break

    for (const mf of data as { namespace: string; key: string }[]) {
      const k = `${mf.namespace}.${mf.key}`
      if (!seen.has(k)) {
        seen.add(k)
        metafields.push(mf)
      }
    }
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  // Resolve readable definition names (best-effort — empty map on any failure,
  // in which case callers fall back to the raw key).
  const nameMap = await getMetafieldNameMap(feedId)
  for (const mf of metafields) {
    const name = nameMap.get(`${mf.namespace}.${mf.key}`)
    if (name) {
      mf.name = name
      continue
    }
    // A metaobject field exposed by the sync ("bundle.price" under the
    // metafield "bundle") has no definition of its own; label it after its
    // parent so it reads "Bundle › price" next to "Bundle" in the pickers.
    const dot = mf.key.indexOf('.')
    const parentName = dot === -1 ? undefined : nameMap.get(`${mf.namespace}.${mf.key.slice(0, dot)}`)
    if (parentName) mf.name = `${parentName} › ${mf.key.slice(dot + 1)}`
  }

  return Response.json({ metafields })
}
