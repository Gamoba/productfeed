// Master fields: rules set up once on the shop (table master_fields, migration
// 058) and used by every feed of that shop, through the MASTER mapping type or
// a `master:<key>` source (see lib/mappingEval). Read here; written through
// lib/ops/masterFields (shared by the UI and the MCP tools).

import type { SupabaseClient } from '@supabase/supabase-js'
import { createItemEvaluator, MASTER_FIELD_PREFIX, type EvalMapping, type EvalMasterField } from './mappingEval'
import { MASTER_RESOLVER, resolveField } from './feedFilters'
import type { SupabaseProduct } from './sync'

export type MasterField = EvalMasterField & {
  id: string
  project_id: string
  name: string
  description: string | null
  updated_at: string
}

/** Mapping types a master field can use: every type except AI and MASTER. */
export const MASTER_FIELD_TYPES = [
  'FIELD',
  'STATIC',
  'COMBINE',
  'PREFIX_SUFFIX',
  'FIND_REPLACE',
  'TRUNCATE',
  'STRIP_HTML',
  'LOOKUP',
  'EXTRACT',
] as const

const COLUMNS = 'id, project_id, key, name, description, mapping_type, config, updated_at'

// Best effort: before migration 058 the table doesn't exist, and feeds must
// still generate (with master references reading '').
export async function loadMasterFields(db: SupabaseClient, projectId: string): Promise<MasterField[]> {
  const { data, error } = await db.from('master_fields').select(COLUMNS).eq('project_id', projectId).order('name')
  if (error) return []
  return (data ?? []) as MasterField[]
}

export async function loadMasterFieldsForFeed(db: SupabaseClient, feedId: string): Promise<MasterField[]> {
  const { data: feed } = await db.from('feeds').select('project_id').eq('id', feedId).maybeSingle()
  return feed?.project_id ? loadMasterFields(db, feed.project_id as string) : []
}

/** A readable, stable key from a name: "Title with size" → "title_with_size". */
export function masterKeyFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
  return base || 'field'
}

/** Feeds of the shop whose mappings use a master field, per key. */
export function masterUsage(
  mappings: { feed_id: string; mapping_type: string; config: unknown }[]
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (key: string, feedId: string) => {
    if (!out.has(key)) out.set(key, new Set())
    out.get(key)!.add(feedId)
  }
  for (const m of mappings) {
    const cfg = (m.config ?? {}) as Record<string, unknown>
    if (m.mapping_type === 'MASTER' && cfg.master) add(String(cfg.master), m.feed_id)
    for (const hit of JSON.stringify(cfg).matchAll(/"master:([a-z0-9_]+)"/g)) add(hit[1], m.feed_id)
  }
  return out
}

/**
 * Lets include/exclude rules read `master:<key>` (lib/feedFilters). Each
 * product gets a resolver that evaluates the master field lazily, with the
 * feed's mappings for its `feed:` references and the product's accepted AI
 * title. Not enumerable, so it never ends up in JSON; re-attaching replaces it.
 */
export function attachMasterResolvers(
  products: SupabaseProduct[],
  ctx: { masters: EvalMasterField[]; mappings: EvalMapping[]; marketUrl: string | null }
): void {
  for (const product of products) {
    let ev: ReturnType<typeof createItemEvaluator> | null = null
    const t = (product as Record<string, unknown>).optimized_title
    const resolve = (key: string) => {
      ev ??= createItemEvaluator({
        mappings: ctx.mappings,
        masters: ctx.masters,
        resolveSource: (f) => resolveField(f, product, ctx.marketUrl),
        aiTitle: typeof t === 'string' && t.trim() ? t : null,
      })
      return ev.resolve(MASTER_FIELD_PREFIX + key)
    }
    Object.defineProperty(product, MASTER_RESOLVER, { value: resolve, enumerable: false, configurable: true, writable: true })
  }
}
