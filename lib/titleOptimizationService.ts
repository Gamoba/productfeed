// Service layer for AI title optimization — all the read/write logic the UI
// needs, as plain headless-testable functions (DB via adminDb). The server
// actions in app/optimize/actions.ts are thin getOwnedFeed-guarded wrappers
// around these.

import { adminDb } from '@/lib/feeds'
import { getMetafieldNameMap } from '@/lib/metafieldDefinitions'
import { dbError } from '@/lib/errors'
import type { SupabaseProduct } from '@/lib/sync'
import { getOptimizationScope, type OverlapSummary } from '@/lib/titleOptimizationScope'
import type { FeedFilter } from '@/lib/feedFilters'
import {
  runTitleOptimization,
  planRun,
  persistOutcomes,
  type RerunChoice,
  type RunResult,
} from '@/lib/titleOptimizationRun'
import {
  createOptimizerClient,
  optimizeBatch,
  toOptimizerProduct,
  localeToLanguage,
  DEFAULT_CHAR_LIMIT,
  type OptimizationOutcome,
  type OptimizerConfig,
  type OptimizerProduct,
  type TitleMethod,
  type TitleRule,
  type ValidationIssue,
} from '@/lib/titleOptimizer'

// ── Settings ─────────────────────────────────────────────────────────────────

export type OptimizationSettings = {
  charLimit: number
  fewShotExamples: string
  model: string | null
  temperature: number | null
}

const DEFAULT_SETTINGS: OptimizationSettings = {
  charLimit: DEFAULT_CHAR_LIMIT,
  fewShotExamples: '',
  model: null,
  temperature: null,
}

export async function getOptimizationSettings(feedId: string): Promise<OptimizationSettings> {
  const db = adminDb()
  const { data } = await db
    .from('title_optimization_settings')
    .select('char_limit, few_shot_examples, model, temperature')
    .eq('feed_id', feedId)
    .maybeSingle()
  if (!data) return { ...DEFAULT_SETTINGS }
  return {
    charLimit: (data.char_limit as number) ?? DEFAULT_CHAR_LIMIT,
    fewShotExamples: (data.few_shot_examples as string) ?? '',
    model: (data.model as string | null) ?? null,
    temperature: (data.temperature as number | null) ?? null,
  }
}

export async function saveOptimizationSettings(
  feedId: string,
  settings: OptimizationSettings
): Promise<void> {
  const db = adminDb()
  const { error } = await db.from('title_optimization_settings').upsert(
    {
      feed_id: feedId,
      char_limit: settings.charLimit,
      few_shot_examples: settings.fewShotExamples,
      model: settings.model,
      temperature: settings.temperature,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'feed_id' }
  )
  if (error) dbError('titleOptimizationService', error)
}

// ── Optimization filters (the separate scope filter set) ─────────────────────

export type OptFilterRule = { field: string; operator: string; value: string; caseSensitive?: boolean }
export type OptFilterConfig = { operator: 'AND' | 'OR'; rules: OptFilterRule[] }

export async function getOptimizationFilters(
  feedId: string
): Promise<{ include: OptFilterConfig; exclude: OptFilterConfig }> {
  const db = adminDb()
  const { data } = await db
    .from('title_optimization_filters')
    .select('filter_type, operator, rules')
    .eq('feed_id', feedId)
  const empty: OptFilterConfig = { operator: 'AND', rules: [] }
  const rows = (data ?? []) as { filter_type: string; operator: 'AND' | 'OR'; rules: OptFilterRule[] }[]
  const pick = (t: string): OptFilterConfig => {
    const r = rows.find((x) => x.filter_type === t)
    return r ? { operator: r.operator, rules: r.rules } : { ...empty }
  }
  return { include: pick('include'), exclude: pick('exclude') }
}

export async function saveOptimizationFilters(
  feedId: string,
  include: OptFilterConfig,
  exclude: OptFilterConfig
): Promise<void> {
  const db = adminDb()
  const { error } = await db.from('title_optimization_filters').upsert(
    [
      { feed_id: feedId, filter_type: 'include', operator: include.operator, rules: include.rules },
      { feed_id: feedId, filter_type: 'exclude', operator: exclude.operator, rules: exclude.rules },
    ],
    { onConflict: 'feed_id,filter_type' }
  )
  if (error) dbError('titleOptimizationService', error)
}

// ── Overlap (pre-run summary) ────────────────────────────────────────────────

// Only the counts cross to the client — never the product list.
export async function getOptimizationOverlap(feedId: string): Promise<OverlapSummary> {
  const scope = await getOptimizationScope(feedId)
  return scope.summary
}

// Overlap for an UNSAVED filter set — powers the Scope editor's live "X in
// scope" as the user edits, via the same applyFeedFilters as a real run.
export async function getOptimizationOverlapForFilters(
  feedId: string,
  include: OptFilterConfig,
  exclude: OptFilterConfig
): Promise<OverlapSummary> {
  const filterRows: FeedFilter[] = [
    { filter_type: 'include', operator: include.operator, rules: include.rules },
    { filter_type: 'exclude', operator: exclude.operator, rules: exclude.rules },
  ]
  const scope = await getOptimizationScope(feedId, filterRows)
  return scope.summary
}

// ── Method B rules ───────────────────────────────────────────────────────────

export async function getTitleRules(feedId: string): Promise<TitleRule[]> {
  const db = adminDb()
  const { data } = await db
    .from('title_rules')
    .select('product_type, priority_attributes, required_attributes, excluded_attributes')
    .eq('feed_id', feedId)
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    product_type: r.product_type as string,
    priority_attributes: (r.priority_attributes as string[]) ?? [],
    required_attributes: (r.required_attributes as string[]) ?? [],
    excluded_attributes: (r.excluded_attributes as string[]) ?? [],
  }))
}

export async function saveTitleRule(feedId: string, rule: TitleRule): Promise<void> {
  const db = adminDb()
  const { error } = await db.from('title_rules').upsert(
    {
      feed_id: feedId,
      product_type: rule.product_type,
      priority_attributes: rule.priority_attributes,
      required_attributes: rule.required_attributes,
      excluded_attributes: rule.excluded_attributes,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'feed_id,product_type' }
  )
  if (error) dbError('titleOptimizationService', error)
}

export async function deleteTitleRule(feedId: string, productType: string): Promise<void> {
  const db = adminDb()
  const { error } = await db
    .from('title_rules')
    .delete()
    .eq('feed_id', feedId)
    .eq('product_type', productType)
  if (error) dbError('titleOptimizationService', error)
}

// ── Manual edit ──────────────────────────────────────────────────────────────

// Sets a human-edited title. Preserves original_title (the re-run source) from
// any existing row; for a product with no prior row, original_title is the
// current Shopify title. status becomes 'human_edited' (protected on re-runs).
export async function saveManualTitle(
  feedId: string,
  productRef: string,
  title: string
): Promise<void> {
  const db = adminDb()
  const trimmed = title.trim()
  if (!trimmed) throw new Error('Title cannot be empty')

  const { data: existing } = await db
    .from('product_title_optimizations')
    .select('original_title, proposed_title, method, source_hash')
    .eq('feed_id', feedId)
    .eq('product_ref', productRef)
    .maybeSingle()

  let originalTitle = existing?.original_title as string | undefined
  if (originalTitle === undefined) {
    const { data: product } = await db
      .from('products')
      .select('title')
      .eq('feed_id', feedId)
      .eq('shopify_id', productRef)
      .maybeSingle()
    originalTitle = (product?.title as string | null) ?? trimmed
  }

  const { error } = await db.from('product_title_optimizations').upsert(
    {
      feed_id: feedId,
      product_ref: productRef,
      status: 'human_edited',
      original_title: originalTitle,
      proposed_title: (existing?.proposed_title as string | null) ?? null,
      optimized_title: trimmed,
      method: (existing?.method as string | null) ?? null,
      source_hash: (existing?.source_hash as string | null) ?? null,
      validation_issues: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'feed_id,product_ref' }
  )
  if (error) dbError('titleOptimizationService', error)
}

// ── Review (needs_review queue) ──────────────────────────────────────────────

// One product awaiting manual review — its AI title failed code validation (or
// the response couldn't be parsed). proposed_title is null only in the latter
// case. validation_issues says why it failed, for the review UI.
export type ReviewItem = {
  product_ref: string
  original_title: string
  proposed_title: string | null
  validation_issues: ValidationIssue[]
  method: string | null
}

// The bucket's needs_review products (newest first). Scoped by the producing
// bucket_id so each bucket reviews only what it generated.
export async function listBucketReview(feedId: string, bucketId: string): Promise<ReviewItem[]> {
  const { data, error } = await adminDb()
    .from('product_title_optimizations')
    .select('product_ref, original_title, proposed_title, validation_issues, method, updated_at')
    .eq('feed_id', feedId)
    .eq('bucket_id', bucketId)
    .eq('status', 'needs_review')
    .order('updated_at', { ascending: false })
  if (error) dbError('titleOptimizationService', error)
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    product_ref: r.product_ref as string,
    original_title: r.original_title as string,
    proposed_title: (r.proposed_title as string | null) ?? null,
    validation_issues: (r.validation_issues as ValidationIssue[] | null) ?? [],
    method: (r.method as string | null) ?? null,
  }))
}

// Reject a needs_review proposal: lock the product to its ORIGINAL title and
// mark it human_edited, so the feed keeps the original and re-runs leave it
// alone (it won't return to the review queue). Reuses saveManualTitle's upsert
// (which preserves bucket_id and clears validation_issues).
export async function rejectOptimization(feedId: string, productRef: string): Promise<void> {
  const { data } = await adminDb()
    .from('product_title_optimizations')
    .select('original_title')
    .eq('feed_id', feedId)
    .eq('product_ref', productRef)
    .maybeSingle()
  const original = data?.original_title as string | undefined
  if (!original) throw new Error('The product has no optimisation row to reject')
  await saveManualTitle(feedId, productRef, original)
}

// ── Results (the bucket's whole catalogue + its optimization state) ───────────

export type ResultStatus = 'ai_generated' | 'human_edited' | 'needs_review' | 'not_optimized'

// One row in the unified Results view: original vs. new title + status. new_title
// is the accepted title, or (for needs_review) the proposed title that failed
// validation, or null when the product has no optimization row yet.
export type ResultItem = {
  product_ref: string
  original_title: string
  new_title: string | null
  status: ResultStatus
  validation_issues: ValidationIssue[]
  image_url: string | null // first product image (cached at sync), for the row thumbnail
}

// Sort key: surface review work first, then the un-touched, then the done.
const RESULT_ORDER: Record<ResultStatus, number> = {
  needs_review: 0,
  not_optimized: 1,
  ai_generated: 2,
  human_edited: 3,
}

// Every product in the bucket, joined with its optimization row (if any).
// Products with no row are 'not_optimized' (the feed uses their Shopify title).
// bucket_products is queried directly to avoid a circular import with
// optimizationBuckets (which imports this module).
export async function listBucketResults(feedId: string, bucketId: string): Promise<ResultItem[]> {
  const db = adminDb()
  // Paged: a bucket can hold >1000 products and an unpaged read caps at 1000,
  // which would silently truncate the results list. product_ref is unique per
  // (feed, bucket) → a stable page key. (Inlined rather than reusing
  // optimizationBuckets.pageAll to keep this module free of that circular import.)
  const refs: string[] = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data: members } = await db
      .from('bucket_products')
      .select('product_ref')
      .eq('feed_id', feedId)
      .eq('bucket_id', bucketId)
      .order('product_ref', { ascending: true })
      .range(from, from + PAGE - 1)
    const rows = (members ?? []) as { product_ref: string }[]
    refs.push(...rows.map((m) => m.product_ref))
    if (rows.length < PAGE) break
  }
  if (refs.length === 0) return []

  const titleByRef = new Map<string, string>()
  const imageByRef = new Map<string, string>()
  const optByRef = new Map<string, Record<string, unknown>>()
  const CHUNK = 200
  for (let i = 0; i < refs.length; i += CHUNK) {
    const slice = refs.slice(i, i + CHUNK)
    const [{ data: prods }, { data: opts }] = await Promise.all([
      db.from('products').select('shopify_id, title, images').eq('feed_id', feedId).in('shopify_id', slice),
      db
        .from('product_title_optimizations')
        .select('product_ref, status, original_title, optimized_title, proposed_title, validation_issues')
        .eq('feed_id', feedId)
        .in('product_ref', slice),
    ])
    for (const p of (prods ?? []) as { shopify_id: string; title: string | null; images: { src?: string }[] | null }[]) {
      titleByRef.set(p.shopify_id, p.title ?? '')
      const src = p.images?.[0]?.src
      if (src) imageByRef.set(p.shopify_id, src)
    }
    for (const o of (opts ?? []) as Record<string, unknown>[]) optByRef.set(o.product_ref as string, o)
  }

  const items: ResultItem[] = refs.map((ref) => {
    const image_url = imageByRef.get(ref) ?? null
    const opt = optByRef.get(ref)
    if (!opt) {
      return {
        product_ref: ref,
        original_title: titleByRef.get(ref) ?? '',
        new_title: null,
        status: 'not_optimized',
        validation_issues: [],
        image_url,
      }
    }
    return {
      product_ref: ref,
      original_title: (opt.original_title as string | null) ?? titleByRef.get(ref) ?? '',
      new_title: (opt.optimized_title as string | null) ?? (opt.proposed_title as string | null) ?? null,
      status: opt.status as ResultStatus,
      validation_issues: (opt.validation_issues as ValidationIssue[] | null) ?? [],
      image_url,
    }
  })
  items.sort((a, b) => RESULT_ORDER[a.status] - RESULT_ORDER[b.status])
  return items
}

// token is the unique field identifier (e.g. "custom.land" / "custom.land_obj"),
// used as a stable React key — two fields can share a display label (both "Land")
// but never a token. label is the human name shown in the UI.
export type ProductField = { token: string; label: string; value: string }
export type ProductDetail = {
  product_ref: string
  current_title: string
  original_title: string
  new_title: string | null
  status: ResultStatus
  validation_issues: ValidationIssue[]
  fields: ProductField[]
}

// Read-only product data for the expandable detail row: the resolved field values
// (metaobject GIDs are already rewritten to labels at sync time) plus the
// optimization state. Used to spot data conflicts (e.g. a vendor that doesn't
// match the title).
export async function getBucketProductDetail(feedId: string, productRef: string): Promise<ProductDetail> {
  const db = adminDb()
  const [{ data: prod }, { data: opt }] = await Promise.all([
    db
      .from('products')
      .select('*, metafields:product_metafields(*)')
      .eq('feed_id', feedId)
      .eq('shopify_id', productRef)
      .maybeSingle(),
    db
      .from('product_title_optimizations')
      .select('status, original_title, optimized_title, proposed_title, validation_issues')
      .eq('feed_id', feedId)
      .eq('product_ref', productRef)
      .maybeSingle(),
  ])
  if (!prod) throw new Error('Product not found')
  const op = toOptimizerProduct(prod as SupabaseProduct)

  // Metafield labels: prefer the definition NAME (e.g. "Årgang") over the raw,
  // possibly-mangled key (e.g. "custom._rgang"). Best-effort — falls back to the
  // key when no definition / Shopify is unreachable.
  const nameMap = await getMetafieldNameMap(feedId)

  const fields: ProductField[] = []
  const push = (token: string, label: string, value: string) => {
    if (value && value.trim()) fields.push({ token, label, value })
  }
  push('vendor', 'Vendor', op.vendor ?? '')
  push('product_type', 'Product type', op.product_type ?? '')
  push('tags', 'Tags', op.tags.join(', '))
  push('variant_options', 'Variant options', op.variant_options.join(', '))
  // Metafield token = "namespace.key" (always unique); label prefers the
  // definition name (which CAN collide, e.g. two fields both named "Land").
  for (const m of op.metafields) push(m.key, nameMap.get(m.key) ?? m.key, m.value)

  const status = (opt?.status as ResultStatus | undefined) ?? 'not_optimized'
  return {
    product_ref: productRef,
    current_title: (prod as SupabaseProduct).title ?? '',
    original_title: (opt?.original_title as string | undefined) ?? (prod as SupabaseProduct).title ?? '',
    new_title: (opt?.optimized_title as string | null) ?? (opt?.proposed_title as string | null) ?? null,
    status,
    validation_issues: (opt?.validation_issues as ValidationIssue[] | null) ?? [],
    fields,
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

// Builds the run config (settings + market language) and the rule map for the
// chosen method — shared by the full run, preview, and chunked run.
type RunContext = { config: OptimizerConfig; rulesByType: Map<string, TitleRule> }

async function buildRunContext(feedId: string, method: TitleMethod): Promise<RunContext> {
  const db = adminDb()
  const [settings, { data: shopSettings }] = await Promise.all([
    getOptimizationSettings(feedId),
    db.from('shop_settings').select('selected_locale').eq('feed_id', feedId).maybeSingle(),
  ])
  const config: OptimizerConfig = {
    charLimit: settings.charLimit,
    targetLanguage: localeToLanguage(shopSettings?.selected_locale as string | null),
    fewShotExamples: settings.fewShotExamples,
    model: settings.model ?? undefined,
    temperature: settings.temperature ?? undefined,
  }
  const rulesByType = new Map<string, TitleRule>()
  if (method === 'rule_based') {
    for (const rule of await getTitleRules(feedId)) rulesByType.set(rule.product_type, rule)
  }
  return { config, rulesByType }
}

// Re-run source: stored original_title when one exists, else the product title.
function buildOp(product: SupabaseProduct, originalTitle?: string): OptimizerProduct {
  const op = toOptimizerProduct(product)
  if (originalTitle !== undefined) op.title = originalTitle
  return op
}

// Full run (all in-scope, respecting the choice). Counts only — used by the
// non-chunked path / future sync.
export async function runOptimization(
  feedId: string,
  method: TitleMethod,
  choice: RerunChoice
): Promise<RunResult> {
  const { config, rulesByType } = await buildRunContext(feedId, method)
  return runTitleOptimization(feedId, method, choice, config, { rulesByType })
}

// Returns the product_refs a run would process (post skip/re-run decision) plus
// the overlap summary — the UI uses targets.length as the progress total and
// chunks the targets through runOptimizationForRefs.
export type RunPlanSummary = { targets: string[]; summary: OverlapSummary }

export async function planOptimization(
  feedId: string,
  choice: RerunChoice
): Promise<RunPlanSummary> {
  const scope = await getOptimizationScope(feedId)
  const plan = planRun(scope, choice)
  const targets = [...new Set(plan.toProcess.map((p) => p.shopify_id))]
  return { targets, summary: scope.summary }
}

// Dry run on the first `limit` in-scope products — generates titles WITHOUT
// persisting, for experimenting (e.g. before few-shot examples are set). Capped.
export async function previewOptimization(
  feedId: string,
  method: TitleMethod,
  limit: number
): Promise<OptimizationOutcome[]> {
  const scope = await getOptimizationScope(feedId)
  const n = Math.max(1, Math.min(limit, 50))
  const sample = scope.products.slice(0, n)
  const ops = sample.map((p) => buildOp(p, scope.existingByRef.get(p.shopify_id)?.original_title))
  const { config, rulesByType } = await buildRunContext(feedId, method)
  const client = createOptimizerClient()
  return optimizeBatch(client, ops, method, config, rulesByType)
}

// Runs the optimizer for a specific set of product_refs (a chunk from
// planOptimization.targets), persists, and returns outcomes for display. The
// refs are already filtered by the plan, so the choice is not re-applied here.
export async function runOptimizationForRefs(
  feedId: string,
  method: TitleMethod,
  refs: string[]
): Promise<OptimizationOutcome[]> {
  if (refs.length === 0) return []
  const db = adminDb()
  const { config, rulesByType } = await buildRunContext(feedId, method)
  const [{ data: prods }, { data: ex }] = await Promise.all([
    db.from('products').select('*, metafields:product_metafields(*)').eq('feed_id', feedId).in('shopify_id', refs),
    db.from('product_title_optimizations').select('product_ref, original_title').eq('feed_id', feedId).in('product_ref', refs),
  ])
  const origByRef = new Map(
    ((ex ?? []) as { product_ref: string; original_title: string }[]).map((r) => [
      r.product_ref,
      r.original_title,
    ])
  )
  const ops = ((prods ?? []) as SupabaseProduct[]).map((p) => buildOp(p, origByRef.get(p.shopify_id)))
  const client = createOptimizerClient()
  const outcomes = await optimizeBatch(client, ops, method, config, rulesByType)
  await persistOutcomes(feedId, outcomes)
  return outcomes
}
