// The distinct metafields of a feed's products, with a row count each.
//
// One grouped query through the database function feed_metafield_keys
// (migration 059). Before that migration, or if the call fails, it falls back
// to paging through product_metafields, which is correct but slow (one request
// per 1000 rows). Shared by the Mapping pickers and the rule editors.

import type { SupabaseClient } from '@supabase/supabase-js'

export type MetafieldKey = { namespace: string; key: string; rows: number }

const PAGE = 1000

export async function listFeedMetafieldKeys(db: SupabaseClient, feedId: string): Promise<MetafieldKey[]> {
  const { data, error } = await db.rpc('feed_metafield_keys', { p_feed_id: feedId })
  if (!error && Array.isArray(data)) {
    return (data as { namespace: string; key: string; rows: number | string }[]).map((r) => ({
      namespace: r.namespace,
      key: r.key,
      rows: Number(r.rows),
    }))
  }

  const counts = new Map<string, MetafieldKey>()
  for (let from = 0; ; from += PAGE) {
    const { data: page, error: pageErr } = await db
      .from('product_metafields')
      .select('namespace, key')
      .eq('feed_id', feedId)
      .order('id')
      .range(from, from + PAGE - 1)
    if (pageErr) throw new Error(`Metafields failed: ${pageErr.message}`)
    const rows = (page ?? []) as { namespace: string; key: string }[]
    for (const r of rows) {
      const k = `${r.namespace}.${r.key}`
      const hit = counts.get(k)
      if (hit) hit.rows++
      else counts.set(k, { namespace: r.namespace, key: r.key, rows: 1 })
    }
    if (rows.length < PAGE) break
  }
  return [...counts.values()].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key))
}
