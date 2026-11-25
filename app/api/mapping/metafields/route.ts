import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { getMetafieldNameMap } from '@/lib/metafieldDefinitions'
import { listFeedMetafieldKeys } from '@/lib/metafieldKeys'

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
  } = await getSessionUser(supabase)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) return Response.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return Response.json({ error: 'Feed not found' }, { status: 404 })

  // One grouped query (lib/metafieldKeys); this used to page through every
  // metafield row of the feed.
  const db = adminDb()
  let metafields: { namespace: string; key: string; name?: string }[]
  try {
    metafields = (await listFeedMetafieldKeys(db, feedId)).map(({ namespace, key }) => ({ namespace, key }))
  } catch (error) {
    return errorResponse(error, 'GET /api/mapping/metafields')
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
