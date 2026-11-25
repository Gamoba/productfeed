// Bucket layer for AI title optimization.
//
// A bucket = a named (filter + method + rules) unit within a feed, with an
// EXPLICIT, frozen product membership (bucket_products) — not the filter
// recomputed on the fly. One product belongs to exactly one bucket per feed
// (UNIQUE(feed_id, product_ref)). This module is the headless-testable service
// for buckets: CRUD, membership/overlap, per-bucket filters/rules, and the run.
//
// Membership ≠ optimized title: membership lives in bucket_products; produced
// titles live in product_title_optimizations (now stamped with bucket_id).

import { adminDb } from '@/lib/feeds'
import type { SupabaseProduct } from '@/lib/sync'
import { applyFeedFilters, type FeedFilter } from '@/lib/feedFilters'
import { listFeedMetafieldKeys } from '@/lib/metafieldKeys'
import { dbError } from '@/lib/errors'
import { getMetafieldNameMap } from '@/lib/metafieldDefinitions'
import {
  fetchAllActiveProducts,
  type OptimizationScope,
  type ExistingStatus,
  type ExistingOptimization,
  type OverlapSummary,
} from '@/lib/titleOptimizationScope'
import {
  planRun,
  persistOutcomes,
  type RerunChoice,
} from '@/lib/titleOptimizationRun'
import {
  createOptimizerClient,
  optimizeBatch,
  toOptimizerProduct,
  localeToLanguage,
  type OptimizationOutcome,
  type OptimizerConfig,
  type OptimizerProduct,
  type TitleMethod,
  type TitleRule,
} from '@/lib/titleOptimizer'
import { getOptimizationSettings, type OptFilterConfig } from '@/lib/titleOptimizationService'

const IN_CHUNK = 200 // cap .in() list size to stay under URL limits

// ── Types ────────────────────────────────────────────────────────────────────

export type BucketMethod = 'auto' | 'rule_based'

export type Bucket = {
  id: string
  feed_id: string
  name: string
  method: BucketMethod
  // Optional Google Shopping custom label for split-testing (migration 027). Set
  // together or both null. When set, every product in this bucket emits
  // <g:custom_label_{index}>{value}</g:custom_label_{index}> in the feed.
  custom_label_index: number | null
  custom_label_value: string | null
  created_at: string
  updated_at: string
}

export type BucketSummary = Bucket & {
  memberCount: number
  aiGenerated: number
  humanEdited: number
  needsReview: number
}

// A candidate product that already belongs to a DIFFERENT bucket. `title` is the
// product's current Shopify title, shown in the overlap UI so the user can see
// which products they pull in/leave (product_ref stays the internal key).
export type BucketConflict = {
  product_ref: string
  title: string
  bucketId: string
  bucketName: string
  status: ExistingStatus | null
}

// A metafield that actually occurs in this feed's products, with how many
// products carry it. The UI joins them as `namespace.key` — the token tail the
// filter stores as `metafield:namespace.key` and resolveField reads.
export type FeedMetafield = { namespace: string; key: string; count: number; name?: string }

// ── Internal helpers ─────────────────────────────────────────────────────────

function db() {
  return adminDb()
}

// Verifies the bucket exists in this feed (ownership belt — callers also pass
// through getOwnedFeed at the action layer).
export async function getBucket(feedId: string, bucketId: string): Promise<Bucket | null> {
  const { data } = await db()
    .from('optimization_buckets')
    .select('*')
    .eq('id', bucketId)
    .eq('feed_id', feedId)
    .maybeSingle()
  return (data as Bucket | null) ?? null
}

// PostgREST returns at most 1000 rows per request. Page through a query so reads
// see EVERY row — without this a bucket with >1000 members reports a count capped
// at 1000 and setBucketMembership's cleanup delete only sees the first 1000 rows,
// leaving orphans behind. That is exactly how Scope (the true filter count) and
// Examples/Run (the capped membership read) drifted apart. Mirrors
// fetchAllActiveProducts. The query factory MUST apply a stable `.order()` so page
// boundaries don't skip or duplicate rows.
async function pageAll<T>(
  query: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string; code?: string; hint?: string | null } | null }>
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1)
    if (error) dbError('optimizationBuckets page', error)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

// Fetches products (with metafields) for a set of refs, chunking the .in() list.
async function fetchProductsByRefs(feedId: string, refs: string[]): Promise<SupabaseProduct[]> {
  const out: SupabaseProduct[] = []
  for (let i = 0; i < refs.length; i += IN_CHUNK) {
    const { data, error } = await db()
      .from('products')
      .select('*, metafields:product_metafields(*)')
      .eq('feed_id', feedId)
      .in('shopify_id', refs.slice(i, i + IN_CHUNK))
    if (error) dbError('optimizationBuckets products', error)
    out.push(...((data ?? []) as SupabaseProduct[]))
  }
  return out
}

// Builds the run config (per-feed settings + market language) and the bucket's
// rule map (only for rule_based).
async function buildBucketContext(
  feedId: string,
  bucketId: string,
  method: TitleMethod
): Promise<{ config: OptimizerConfig; rulesByType: Map<string, TitleRule> }> {
  // Step 5 — the run is coupled to the bucket's workshop output: its free-text
  // instructions, its prioritised input fields, and its APPROVED examples as the
  // few-shot. These replace the retired feed-level few-shot text (queried directly
  // to avoid a circular import with lib/bucketExamples, which imports this module).
  const [settings, { data: shopSettings }, { data: titleConfig }, { data: approved }, nameMap] = await Promise.all([
    getOptimizationSettings(feedId),
    db().from('shop_settings').select('selected_locale').eq('feed_id', feedId).maybeSingle(),
    db().from('bucket_title_config').select('instructions, input_fields').eq('bucket_id', bucketId).maybeSingle(),
    db()
      .from('bucket_examples')
      .select('generated_title, position')
      .eq('bucket_id', bucketId)
      .eq('status', 'approved'),
    getMetafieldNameMap(feedId), // token → human name, so the run payload/wish-list match the workshop
  ])

  // Approved titles, ordered by their curated slot, become the few-shot block.
  const fewShotExamples = ((approved ?? []) as { generated_title: string; position: number | null }[])
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((e) => `- ${e.generated_title}`)
    .join('\n')

  const config: OptimizerConfig = {
    charLimit: settings.charLimit,
    targetLanguage: localeToLanguage(shopSettings?.selected_locale as string | null),
    fewShotExamples,
    instructions: (titleConfig?.instructions as string | undefined) ?? '',
    inputFields: (titleConfig?.input_fields as string[] | undefined) ?? [],
    metafieldNames: nameMap,
    model: settings.model ?? undefined,
    temperature: settings.temperature ?? undefined,
  }
  const rulesByType = new Map<string, TitleRule>()
  if (method === 'rule_based') {
    for (const rule of await getBucketRules(feedId, bucketId)) rulesByType.set(rule.product_type, rule)
  }
  return { config, rulesByType }
}

function buildOp(product: SupabaseProduct, originalTitle?: string): OptimizerProduct {
  const op = toOptimizerProduct(product)
  if (originalTitle !== undefined) op.title = originalTitle
  return op
}

// ── Bucket CRUD ──────────────────────────────────────────────────────────────

export async function listBuckets(feedId: string): Promise<BucketSummary[]> {
  // members + opts are feed-wide and can exceed 1000 rows across all buckets, so
  // they're paged too — otherwise the per-bucket counts shown in the list would be
  // capped. product_ref is unique per feed in both tables → a stable page key.
  const [{ data: buckets }, members, opts] = await Promise.all([
    db().from('optimization_buckets').select('*').eq('feed_id', feedId).order('created_at', { ascending: true }),
    pageAll<{ bucket_id: string }>((from, to) =>
      db()
        .from('bucket_products')
        .select('bucket_id')
        .eq('feed_id', feedId)
        .order('product_ref', { ascending: true })
        .range(from, to)
    ),
    pageAll<{ bucket_id: string; status: ExistingStatus }>((from, to) =>
      db()
        .from('product_title_optimizations')
        .select('bucket_id, status')
        .eq('feed_id', feedId)
        .not('bucket_id', 'is', null)
        .order('product_ref', { ascending: true })
        .range(from, to)
    ),
  ])

  const memberCount = new Map<string, number>()
  for (const m of (members ?? []) as { bucket_id: string }[]) {
    memberCount.set(m.bucket_id, (memberCount.get(m.bucket_id) ?? 0) + 1)
  }

  const statusCount = new Map<string, { ai: number; human: number; review: number }>()
  for (const o of (opts ?? []) as { bucket_id: string; status: ExistingStatus }[]) {
    const s = statusCount.get(o.bucket_id) ?? { ai: 0, human: 0, review: 0 }
    if (o.status === 'ai_generated') s.ai++
    else if (o.status === 'human_edited') s.human++
    else s.review++
    statusCount.set(o.bucket_id, s)
  }

  return ((buckets ?? []) as Bucket[]).map((b) => {
    const s = statusCount.get(b.id) ?? { ai: 0, human: 0, review: 0 }
    return {
      ...b,
      memberCount: memberCount.get(b.id) ?? 0,
      aiGenerated: s.ai,
      humanEdited: s.human,
      needsReview: s.review,
    }
  })
}

export async function createBucket(
  feedId: string,
  name: string,
  method: BucketMethod
): Promise<Bucket> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Bucket-navn må ikke være tomt')
  const { data, error } = await db()
    .from('optimization_buckets')
    .insert({ feed_id: feedId, name: trimmed, method })
    .select('*')
    .single()
  if (error) dbError('optimizationBuckets', error)
  return data as Bucket
}

export async function renameBucket(feedId: string, bucketId: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Bucket-navn må ikke være tomt')
  const { error } = await db()
    .from('optimization_buckets')
    .update({ name: trimmed, updated_at: new Date().toISOString() })
    .eq('id', bucketId)
    .eq('feed_id', feedId)
  if (error) dbError('optimizationBuckets', error)
}

export async function setBucketMethod(
  feedId: string,
  bucketId: string,
  method: BucketMethod
): Promise<void> {
  const { error } = await db()
    .from('optimization_buckets')
    .update({ method, updated_at: new Date().toISOString() })
    .eq('id', bucketId)
    .eq('feed_id', feedId)
  if (error) dbError('optimizationBuckets', error)
}

export async function deleteBucket(feedId: string, bucketId: string): Promise<void> {
  const { error } = await db()
    .from('optimization_buckets')
    .delete()
    .eq('id', bucketId)
    .eq('feed_id', feedId)
  if (error) dbError('optimizationBuckets', error)
}

// ── Per-bucket filters ───────────────────────────────────────────────────────

export async function getBucketFilters(
  bucketId: string
): Promise<{ include: OptFilterConfig; exclude: OptFilterConfig }> {
  const { data } = await db()
    .from('title_optimization_filters')
    .select('filter_type, operator, rules')
    .eq('bucket_id', bucketId)
  const rows = (data ?? []) as { filter_type: string; operator: 'AND' | 'OR'; rules: OptFilterConfig['rules'] }[]
  const pick = (t: string): OptFilterConfig => {
    const r = rows.find((x) => x.filter_type === t)
    return r ? { operator: r.operator, rules: r.rules } : { operator: 'AND', rules: [] }
  }
  return { include: pick('include'), exclude: pick('exclude') }
}

export async function saveBucketFilters(
  feedId: string,
  bucketId: string,
  include: OptFilterConfig,
  exclude: OptFilterConfig
): Promise<void> {
  const { error } = await db()
    .from('title_optimization_filters')
    .upsert(
      [
        { feed_id: feedId, bucket_id: bucketId, filter_type: 'include', operator: include.operator, rules: include.rules },
        { feed_id: feedId, bucket_id: bucketId, filter_type: 'exclude', operator: exclude.operator, rules: exclude.rules },
      ],
      { onConflict: 'bucket_id,filter_type' }
    )
  if (error) dbError('optimizationBuckets', error)
}

// ── Per-bucket rules (Method B) ──────────────────────────────────────────────

export async function getBucketRules(feedId: string, bucketId: string): Promise<TitleRule[]> {
  const { data } = await db()
    .from('title_rules')
    .select('product_type, priority_attributes, required_attributes, excluded_attributes')
    .eq('feed_id', feedId)
    .eq('bucket_id', bucketId)
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    product_type: r.product_type as string,
    priority_attributes: (r.priority_attributes as string[]) ?? [],
    required_attributes: (r.required_attributes as string[]) ?? [],
    excluded_attributes: (r.excluded_attributes as string[]) ?? [],
  }))
}

export async function saveBucketRule(
  feedId: string,
  bucketId: string,
  rule: TitleRule
): Promise<void> {
  const { error } = await db()
    .from('title_rules')
    .upsert(
      {
        feed_id: feedId,
        bucket_id: bucketId,
        product_type: rule.product_type,
        priority_attributes: rule.priority_attributes,
        required_attributes: rule.required_attributes,
        excluded_attributes: rule.excluded_attributes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'bucket_id,product_type' }
    )
  if (error) dbError('optimizationBuckets', error)
}

export async function deleteBucketRule(bucketId: string, productType: string): Promise<void> {
  const { error } = await db()
    .from('title_rules')
    .delete()
    .eq('bucket_id', bucketId)
    .eq('product_type', productType)
  if (error) dbError('optimizationBuckets', error)
}

// ── Membership & overlap ─────────────────────────────────────────────────────

// Candidate refs from a (possibly unsaved) filter — applied via the shared
// applyFeedFilters, same as a feed filter.
export async function getBucketCandidates(
  feedId: string,
  include: OptFilterConfig,
  exclude: OptFilterConfig
): Promise<string[]> {
  const [{ data: ss }, products] = await Promise.all([
    db().from('shop_settings').select('market_url').eq('feed_id', feedId).maybeSingle(),
    fetchAllActiveProducts(db(), feedId),
  ])
  const marketUrl = (ss?.market_url as string | null) ?? null
  const filterRows: FeedFilter[] = [
    { filter_type: 'include', operator: include.operator, rules: include.rules },
    { filter_type: 'exclude', operator: exclude.operator, rules: exclude.rules },
  ]
  return applyFeedFilters(products, filterRows, marketUrl).map((p) => p.shopify_id)
}

// Distinct metafields present in this feed's products, each with a product
// count. Powers the scope filter's metafield dropdown (free text → pick from
// what exists). One row per (product, namespace, key) — see the unique
// constraint — so a row count per namespace.key is a product count.
export async function getFeedMetafields(feedId: string): Promise<FeedMetafield[]> {
  // One grouped query (lib/metafieldKeys) instead of paging through every row.
  const counts = new Map((await listFeedMetafieldKeys(db(), feedId)).map((m) => [`${m.namespace}.${m.key}`, m.rows]))
  // Definition names (e.g. "custom._rgang" → "Årgang") so the pickers show the
  // human name, not the mangled key. Best-effort — empty map on any failure.
  const nameMap = await getMetafieldNameMap(feedId)
  return [...counts.entries()]
    .map(([k, count]) => {
      const dot = k.indexOf('.')
      return { namespace: k.slice(0, dot), key: k.slice(dot + 1), count, name: nameMap.get(k) }
    })
    .sort((a, b) => `${a.namespace}.${a.key}`.localeCompare(`${b.namespace}.${b.key}`))
}

// ── Custom labels (split-testing) ────────────────────────────────────────────

// Sets (or clears) a bucket's Google Shopping custom label. Passing a null index
// or an empty value CLEARS both columns (the pair invariant from migration 027).
export async function setBucketCustomLabel(
  feedId: string,
  bucketId: string,
  index: number | null,
  value: string | null
): Promise<void> {
  const trimmed = (value ?? '').trim()
  const clear = index === null || trimmed === ''
  if (!clear && (index! < 0 || index! > 4)) {
    throw new Error('custom_label_index skal være mellem 0 og 4')
  }
  const { error } = await db()
    .from('optimization_buckets')
    .update({
      custom_label_index: clear ? null : index,
      custom_label_value: clear ? null : trimmed,
      updated_at: new Date().toISOString(),
    })
    .eq('id', bucketId)
    .eq('feed_id', feedId)
  if (error) dbError('optimizationBuckets', error)
}

// Which custom_label_N indices are already set by a feed-level mapping. The feed
// mapping wins at generation time, so the UI warns before a bucket label silently
// loses to one.
export async function getFeedCustomLabelConflicts(feedId: string): Promise<number[]> {
  const { data } = await db().from('feed_mappings').select('google_field').eq('feed_id', feedId)
  const set = new Set<number>()
  for (const r of (data ?? []) as { google_field: string }[]) {
    const m = /^custom_label_([0-4])$/.exec(r.google_field)
    if (m) set.add(Number(m[1]))
  }
  return [...set].sort((a, b) => a - b)
}

export async function getBucketMembership(feedId: string, bucketId: string): Promise<string[]> {
  // Paged: a bucket can hold >1000 products, and an unpaged read silently caps at
  // 1000 — the bug that made Examples/Run see 1000 while Scope showed the real
  // count. product_ref is unique per (feed, bucket), so it's a stable page key.
  const rows = await pageAll<{ product_ref: string }>((from, to) =>
    db()
      .from('bucket_products')
      .select('product_ref')
      .eq('feed_id', feedId)
      .eq('bucket_id', bucketId)
      .order('product_ref', { ascending: true })
      .range(from, to)
  )
  return rows.map((r) => r.product_ref)
}

// For a set of candidate refs, classifies them against existing membership:
// conflicts (in a DIFFERENT bucket), inThisBucket, and unassigned.
export async function getBucketOverlap(
  feedId: string,
  bucketId: string,
  candidateRefs: string[]
): Promise<{ conflicts: BucketConflict[]; inThisBucket: number; unassigned: number }> {
  if (candidateRefs.length === 0) return { conflicts: [], inThisBucket: 0, unassigned: 0 }

  const memberMap = new Map<string, string>() // ref -> bucket_id
  const statusByRef = new Map<string, ExistingStatus>()
  for (let i = 0; i < candidateRefs.length; i += IN_CHUNK) {
    const slice = candidateRefs.slice(i, i + IN_CHUNK)
    const [{ data: members }, { data: opts }] = await Promise.all([
      db().from('bucket_products').select('product_ref, bucket_id').eq('feed_id', feedId).in('product_ref', slice),
      db().from('product_title_optimizations').select('product_ref, status').eq('feed_id', feedId).in('product_ref', slice),
    ])
    for (const m of (members ?? []) as { product_ref: string; bucket_id: string }[]) memberMap.set(m.product_ref, m.bucket_id)
    for (const o of (opts ?? []) as { product_ref: string; status: ExistingStatus }[]) statusByRef.set(o.product_ref, o.status)
  }

  const otherBucketIds = [...new Set([...memberMap.values()].filter((b) => b !== bucketId))]
  const nameById = new Map<string, string>()
  if (otherBucketIds.length) {
    const { data: bks } = await db().from('optimization_buckets').select('id, name').in('id', otherBucketIds)
    for (const b of (bks ?? []) as { id: string; name: string }[]) nameById.set(b.id, b.name)
  }

  let inThisBucket = 0
  let unassigned = 0
  const conflicts: BucketConflict[] = []
  for (const ref of candidateRefs) {
    const b = memberMap.get(ref)
    if (!b) unassigned++
    else if (b === bucketId) inThisBucket++
    else conflicts.push({ product_ref: ref, title: ref, bucketId: b, bucketName: nameById.get(b) ?? '(unknown)', status: statusByRef.get(ref) ?? null })
  }

  // Attach current product titles so the overlap UI shows names, not IDs.
  // Falls back to the ref (already set above) for any product we can't read.
  const conflictRefs = conflicts.map((c) => c.product_ref)
  if (conflictRefs.length) {
    const titleByRef = new Map<string, string>()
    for (let i = 0; i < conflictRefs.length; i += IN_CHUNK) {
      const { data: prods } = await db()
        .from('products')
        .select('shopify_id, title')
        .eq('feed_id', feedId)
        .in('shopify_id', conflictRefs.slice(i, i + IN_CHUNK))
      for (const p of (prods ?? []) as { shopify_id: string; title: string | null }[]) {
        if (p.title) titleByRef.set(p.shopify_id, p.title)
      }
    }
    for (const c of conflicts) c.title = titleByRef.get(c.product_ref) ?? c.product_ref
  }

  return { conflicts, inThisBucket, unassigned }
}

// Sets the bucket's FILTER membership to exactly `refs`. Upserting on (feed_id,
// product_ref) MOVES any ref currently in another bucket into this one
// (enforcing one-bucket-per-product). Manually-added rows (source='manual') in
// THIS bucket are preserved — only the bucket's own 'filter' rows are rewritten,
// so manual additions survive a filter re-confirm.
export async function setBucketMembership(
  feedId: string,
  bucketId: string,
  refs: string[]
): Promise<void> {
  const unique = [...new Set(refs)]

  // This bucket's existing rows + their source. Paged: if a prior (broad) scope
  // wrote >1000 rows, an unpaged read would only see the first 1000 and the
  // cleanup delete below would leave the rest orphaned — keeping membership
  // wrongly large after the filter is narrowed.
  const rowsBySource = await pageAll<{ product_ref: string; source: string }>((from, to) =>
    db()
      .from('bucket_products')
      .select('product_ref, source')
      .eq('feed_id', feedId)
      .eq('bucket_id', bucketId)
      .order('product_ref', { ascending: true })
      .range(from, to)
  )
  const manualRefs = new Set(rowsBySource.filter((r) => r.source === 'manual').map((r) => r.product_ref))
  const currentFilterRefs = rowsBySource.filter((r) => r.source === 'filter').map((r) => r.product_ref)

  if (unique.length) {
    // A ref already manual in THIS bucket stays 'manual' (don't downgrade — it must
    // keep surviving future filter changes); everything else is a 'filter' row.
    const rows = unique.map((product_ref) => ({
      bucket_id: bucketId,
      feed_id: feedId,
      product_ref,
      source: manualRefs.has(product_ref) ? 'manual' : 'filter',
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db()
        .from('bucket_products')
        .upsert(rows.slice(i, i + 500), { onConflict: 'feed_id,product_ref' })
      if (error) dbError('optimizationBuckets', error)
    }
  }

  // Delete only THIS bucket's FILTER rows that are no longer wanted (manual rows
  // are never touched here).
  const keep = new Set(unique)
  const toDelete = currentFilterRefs.filter((r) => !keep.has(r))
  for (let i = 0; i < toDelete.length; i += IN_CHUNK) {
    const { error } = await db()
      .from('bucket_products')
      .delete()
      .eq('feed_id', feedId)
      .eq('bucket_id', bucketId)
      .eq('source', 'filter')
      .in('product_ref', toDelete.slice(i, i + IN_CHUNK))
    if (error) dbError('optimizationBuckets', error)
  }
}

// ── Manual membership (additive to the filter) ───────────────────────────────

// Manually add products to a bucket (source='manual'). Upsert-moves any ref owned
// by another bucket (one-product-one-bucket); callers run getBucketOverlap first
// to warn before a move. Marking them 'manual' makes them survive filter changes.
export async function addManualProducts(feedId: string, bucketId: string, refs: string[]): Promise<void> {
  const unique = [...new Set(refs)].filter(Boolean)
  if (!unique.length) return
  const rows = unique.map((product_ref) => ({ bucket_id: bucketId, feed_id: feedId, product_ref, source: 'manual' }))
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db()
      .from('bucket_products')
      .upsert(rows.slice(i, i + 500), { onConflict: 'feed_id,product_ref' })
    if (error) dbError('optimizationBuckets', error)
  }
}

// Remove a manually-added product. Scoped to source='manual' so it never drops a
// filter member (those are governed by the filter).
export async function removeManualProduct(feedId: string, bucketId: string, ref: string): Promise<void> {
  const { error } = await db()
    .from('bucket_products')
    .delete()
    .eq('feed_id', feedId)
    .eq('bucket_id', bucketId)
    .eq('product_ref', ref)
    .eq('source', 'manual')
  if (error) dbError('optimizationBuckets', error)
}

// The bucket's manually-added products (source='manual'), with titles for the UI.
export async function getBucketManualProducts(
  feedId: string,
  bucketId: string
): Promise<{ product_ref: string; title: string }[]> {
  const { data } = await db()
    .from('bucket_products')
    .select('product_ref')
    .eq('feed_id', feedId)
    .eq('bucket_id', bucketId)
    .eq('source', 'manual')
  const refs = ((data ?? []) as { product_ref: string }[]).map((r) => r.product_ref)
  if (!refs.length) return []
  const titleByRef = new Map<string, string>()
  for (let i = 0; i < refs.length; i += IN_CHUNK) {
    const { data: prods } = await db()
      .from('products')
      .select('shopify_id, title')
      .eq('feed_id', feedId)
      .in('shopify_id', refs.slice(i, i + IN_CHUNK))
    for (const p of (prods ?? []) as { shopify_id: string; title: string | null }[]) {
      titleByRef.set(p.shopify_id, p.title ?? p.shopify_id)
    }
  }
  return refs.map((r) => ({ product_ref: r, title: titleByRef.get(r) ?? r }))
}

// Free-text product search (title/vendor) for the manual-add picker. Sanitises
// the query so it can't break the PostgREST or-filter.
export async function searchFeedProducts(
  feedId: string,
  query: string,
  limit = 20
): Promise<{ product_ref: string; title: string; vendor: string | null; image_url: string | null }[]> {
  const safe = query.replace(/[,()]/g, ' ').trim()
  if (!safe) return []
  const like = `%${safe}%`
  const { data, error } = await db()
    .from('products')
    .select('shopify_id, title, vendor, images')
    .eq('feed_id', feedId)
    .eq('status', 'active')
    .or(`title.ilike.${like},vendor.ilike.${like}`)
    .limit(limit)
  if (error) dbError('optimizationBuckets product search', error)
  return ((data ?? []) as { shopify_id: string; title: string | null; vendor: string | null; images: { src?: string }[] | null }[]).map(
    (p) => ({
      product_ref: p.shopify_id,
      title: p.title ?? p.shopify_id,
      vendor: p.vendor ?? null,
      image_url: p.images?.[0]?.src ?? null,
    })
  )
}

// ── Bucket scope (membership-based, for planRun) ─────────────────────────────

async function getBucketScope(feedId: string, bucketId: string): Promise<OptimizationScope> {
  const refs = await getBucketMembership(feedId, bucketId)
  const [{ data: ss }, products, existingRows] = await Promise.all([
    db().from('shop_settings').select('market_url').eq('feed_id', feedId).maybeSingle(),
    refs.length ? fetchProductsByRefs(feedId, refs) : Promise.resolve([] as SupabaseProduct[]),
    refs.length ? fetchExistingByRefs(feedId, refs) : Promise.resolve([] as ExistingRow[]),
  ])

  const marketUrl = (ss?.market_url as string | null) ?? null
  const existingByRef = new Map<string, ExistingOptimization>()
  for (const r of existingRows) {
    existingByRef.set(r.product_ref, { status: r.status, original_title: r.original_title, source_hash: r.source_hash })
  }

  const summary: OverlapSummary = {
    inScope: products.length,
    alreadyOptimized: 0,
    humanEdited: 0,
    needsReview: 0,
    notYetOptimized: 0,
  }
  for (const p of products) {
    const e = existingByRef.get(p.shopify_id)
    if (!e) summary.notYetOptimized++
    else if (e.status === 'ai_generated') summary.alreadyOptimized++
    else if (e.status === 'human_edited') summary.humanEdited++
    else summary.needsReview++
  }

  return { feedId, marketUrl, products, existingByRef, summary }
}

type ExistingRow = { product_ref: string; status: ExistingStatus; original_title: string; source_hash: string | null }

async function fetchExistingByRefs(feedId: string, refs: string[]): Promise<ExistingRow[]> {
  const out: ExistingRow[] = []
  for (let i = 0; i < refs.length; i += IN_CHUNK) {
    const { data } = await db()
      .from('product_title_optimizations')
      .select('product_ref, status, original_title, source_hash')
      .eq('feed_id', feedId)
      .in('product_ref', refs.slice(i, i + IN_CHUNK))
    out.push(...((data ?? []) as ExistingRow[]))
  }
  return out
}

// ── Run a bucket ─────────────────────────────────────────────────────────────

// Plan: which membership refs a run would process (skip/re-run/human-edited),
// plus the membership overlap summary. The UI chunks `targets` through runBucketRefs.
export async function planBucketRun(
  feedId: string,
  bucketId: string,
  choice: RerunChoice
): Promise<{ targets: string[]; summary: OverlapSummary }> {
  const scope = await getBucketScope(feedId, bucketId)
  const plan = planRun(scope, choice)
  const targets = [...new Set(plan.toProcess.map((p) => p.shopify_id))]
  return { targets, summary: scope.summary }
}

// Runs the optimizer for a chunk of the bucket's targets, persists with
// bucket_id, returns outcomes. Re-run source is the stored original_title.
export async function runBucketRefs(
  feedId: string,
  bucketId: string,
  refs: string[]
): Promise<OptimizationOutcome[]> {
  if (refs.length === 0) return []
  const bucket = await getBucket(feedId, bucketId)
  if (!bucket) throw new Error('Bucket ikke fundet')

  const { config, rulesByType } = await buildBucketContext(feedId, bucketId, bucket.method)
  const [products, existing] = await Promise.all([
    fetchProductsByRefs(feedId, refs),
    fetchExistingByRefs(feedId, refs),
  ])
  const origByRef = new Map(existing.map((r) => [r.product_ref, r.original_title]))
  const ops = products.map((p) => buildOp(p, origByRef.get(p.shopify_id)))

  const client = createOptimizerClient()
  const outcomes = await optimizeBatch(client, ops, bucket.method, config, rulesByType)
  await persistOutcomes(feedId, outcomes, bucketId)
  return outcomes
}

