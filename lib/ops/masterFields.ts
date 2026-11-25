// Master field changes, shared by the Master fields page (server actions) and
// the MCP tools. Callers check access to the shop first (getOwnedProject).
// Saving re-validates every feed that uses the field, after the response.
//
// Nothing here talks to Shopify: master fields are FeedFlow's own configuration.

import type { SupabaseClient } from '@supabase/supabase-js'
import { describeMapping, logActivity } from '@/lib/activity'
import { loadMasterFields, masterKeyFromName, masterUsage, MASTER_FIELD_TYPES, type MasterField } from '@/lib/masterFields'
import { afterResponse, extractWarnings, refreshFeedCache, type OpContext, type OpResult } from './feedConfig'

export type MasterFieldInput = {
  /** Set when changing an existing master field; a new one gets a key from its name. */
  key?: string | null
  name: string
  description?: string | null
  mapping_type: string
  config: Record<string, unknown>
}

const feedsText = (n: number) => (n === 1 ? '1 feed' : '{n} feeds'.replace('{n}', String(n)))

/** Which of the shop's feeds use each master field (by key). */
export async function masterFieldUsage(db: SupabaseClient, projectId: string): Promise<Map<string, Set<string>>> {
  const { data: feeds } = await db.from('feeds').select('id').eq('project_id', projectId)
  const ids = (feeds ?? []).map((f) => f.id as string)
  if (!ids.length) return new Map()
  const { data } = await db.from('feed_mappings').select('feed_id, mapping_type, config').in('feed_id', ids)
  return masterUsage((data ?? []) as { feed_id: string; mapping_type: string; config: unknown }[])
}

export async function saveMasterField(
  db: SupabaseClient,
  ctx: OpContext,
  projectId: string,
  input: MasterFieldInput
): Promise<OpResult & { key?: string }> {
  const name = input.name.trim()
  if (!name) return { error: 'Giv master fieldet et navn.' }
  if (!input.mapping_type) return { error: 'Vælg, hvordan værdien bygges.' }
  if (!(MASTER_FIELD_TYPES as readonly string[]).includes(input.mapping_type)) return { error: 'Master fields kan ikke bruge den type (AI og Master field er ikke tilladt).' }

  const existing = await loadMasterFields(db, projectId)
  const prev = input.key ? existing.find((m) => m.key === input.key) : undefined
  if (input.key && !prev) return { error: 'Det master field findes ikke længere.' }

  let key = prev?.key
  if (!key) {
    const base = masterKeyFromName(name)
    const taken = new Set(existing.map((m) => m.key))
    key = base
    for (let i = 2; taken.has(key); i++) key = `${base}_${i}`
  }

  const row = {
    project_id: projectId,
    key,
    name: name.slice(0, 120),
    description: input.description?.trim() || null,
    mapping_type: input.mapping_type,
    config: input.config ?? {},
    updated_at: new Date().toISOString(),
  }
  const { error } = prev
    ? await db.from('master_fields').update(row).eq('id', prev.id)
    : await db.from('master_fields').insert(row)
  if (error) return { error: error.message }

  await logActivity(db, {
    user: ctx.user,
    via: ctx.via,
    projectId,
    area: 'Master fields',
    action: (prev ? 'Master field "{name}" ændret' : 'Master field "{name}" oprettet').replace('{name}', row.name),
    before: prev ? describeMapping(prev.mapping_type, prev.config) : null,
    after: describeMapping(row.mapping_type, row.config),
  })

  // Every feed that reads this field gets re-validated, as after a mapping save.
  if (prev) {
    const users = [...((await masterFieldUsage(db, projectId)).get(key) ?? [])]
    if (users.length) await afterResponse(async () => {
      for (const feedId of users) await refreshFeedCache(db, feedId)
    })
  }

  const warnings = extractWarnings([{ google_field: row.name, mapping_type: row.mapping_type, config: row.config }])
  return warnings.length ? { key, warnings } : { key }
}

/** Refuses while a feed still uses the field, so no feed silently loses a value. */
export async function deleteMasterField(
  db: SupabaseClient,
  ctx: OpContext,
  projectId: string,
  key: string
): Promise<OpResult> {
  const prev: MasterField | undefined = (await loadMasterFields(db, projectId)).find((m) => m.key === key)
  if (!prev) return { error: 'Det master field findes ikke længere.' }
  const used = (await masterFieldUsage(db, projectId)).get(key)?.size ?? 0
  if (used > 0) return { error: 'Det bruges af {n}. Ret de felter først.'.replace('{n}', feedsText(used)) }

  const { error } = await db.from('master_fields').delete().eq('id', prev.id)
  if (error) return { error: error.message }
  await logActivity(db, {
    user: ctx.user,
    via: ctx.via,
    projectId,
    area: 'Master fields',
    action: 'Master field "{name}" slettet'.replace('{name}', prev.name),
    before: describeMapping(prev.mapping_type, prev.config),
    after: null,
  })
  return {}
}
