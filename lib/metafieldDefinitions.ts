// Maps a product metafield's "namespace.key" to its human-readable DEFINITION
// NAME (e.g. "custom._rgang" → "Årgang"). Shopify metafield KEYS can't hold
// non-ASCII, so a Danish field like "Årgang" is stored under a mangled key
// ("_rgang"); the readable name lives only in the metafield definition. We fetch
// those definitions (a READ-ONLY GraphQL query — never a mutation, per AGENTS.md)
// and cache them per feed, so labels across the UI can show the real name.
//
// Best-effort: any failure (no Shopify connection, throttling, network) resolves
// to an EMPTY map, and callers fall back to the raw "namespace.key" — i.e. the
// pre-existing behaviour, never an error.

import { adminDb } from '@/lib/feeds'
import { getProjectCredentials } from '@/lib/projectShopify'
import { API_VERSION } from '@/lib/shopify'

type CacheEntry = { map: Map<string, string>; expires: number }
const TTL_MS = 10 * 60 * 1000 // definitions change rarely; 10 min is plenty
const cache = new Map<string, CacheEntry>()

type DefNode = { namespace: string; key: string; name: string }

async function fetchDefinitions(feedId: string): Promise<Map<string, string>> {
  const db = adminDb()
  const { data: feed } = await db.from('feeds').select('project_id').eq('id', feedId).maybeSingle()
  const projectId = (feed as { project_id: string | null } | null)?.project_id
  if (!projectId) return new Map()

  // Feed-URL projects have no Shopify definitions — their feed.* metafield keys
  // are already the source feed's readable field names.
  const { data: project } = await db.from('projects').select('source_type').eq('id', projectId).maybeSingle()
  if ((project as { source_type?: string } | null)?.source_type === 'feed_url') return new Map()

  const { shopUrl, accessToken } = await getProjectCredentials(db, projectId)
  const map = new Map<string, string>()
  let cursor: string | null = null

  // Page through all PRODUCT metafield definitions (a shop can have many).
  for (let page = 0; page < 20; page++) {
    const res = await fetch(`https://${shopUrl}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `query($after: String) {
          metafieldDefinitions(first: 250, ownerType: PRODUCT, after: $after) {
            nodes { namespace key name }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: { after: cursor },
      }),
    })
    if (!res.ok) break
    const json = await res.json()
    const conn = json?.data?.metafieldDefinitions
    if (!conn) break
    for (const n of (conn.nodes ?? []) as DefNode[]) {
      if (n?.name && n.name.trim()) map.set(`${n.namespace}.${n.key}`, n.name.trim())
    }
    if (!conn.pageInfo?.hasNextPage) break
    cursor = conn.pageInfo.endCursor as string
  }
  return map
}

// Returns "namespace.key" → definition name for a feed's product metafields.
// Cached per feed; best-effort (returns an empty map on any failure).
export async function getMetafieldNameMap(feedId: string): Promise<Map<string, string>> {
  const hit = cache.get(feedId)
  if (hit && hit.expires > Date.now()) return hit.map
  try {
    const map = await fetchDefinitions(feedId)
    cache.set(feedId, { map, expires: Date.now() + TTL_MS })
    return map
  } catch {
    // Cache a short empty result so a broken connection doesn't hammer Shopify.
    cache.set(feedId, { map: new Map(), expires: Date.now() + 60 * 1000 })
    return new Map()
  }
}
