'use server'

// Thin server actions for AI title optimization — auth + ownership (getOwnedFeed)
// then delegate to the headless service layer (lib/titleOptimizationService).
// Reads return { data } | { error }; mutations return { error? }.

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { logActivity, type Actor } from '@/lib/activity'
import { enforceRateLimit } from '@/lib/rateLimit'
import { clientMessage } from '@/lib/errors'
import * as svc from '@/lib/titleOptimizationService'
import * as buckets from '@/lib/optimizationBuckets'
import * as workshop from '@/lib/bucketExamples'
import type { OverlapSummary } from '@/lib/titleOptimizationScope'
import type { RunResult, RerunChoice } from '@/lib/titleOptimizationRun'
import type { OptimizationOutcome, TitleMethod, TitleRule } from '@/lib/titleOptimizer'

// Resolves the caller and verifies they own the feed.
async function requireOwnedFeed(feedId: string): Promise<{ userId: string; user: Actor } | { error: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }
  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed ikke fundet' }
  return { userId: user.id, user }
}

// Activity log for AI Titles (Shop › Activity log). Generation runs are not
// logged chunk by chunk; what a person decides (buckets, scope, approvals) is.
async function logTitles(user: Actor, feedId: string, action: string, before?: string | null, after?: string | null) {
  await logActivity(adminDb(), { user, feedId, area: 'AI Titles', action, before, after })
}

// Verifies the caller owns the feed AND the bucket belongs to it — guards every
// bucket-scoped action so a bucketId from another feed can't leak/corrupt data.
async function requireOwnedBucket(
  feedId: string,
  bucketId: string
): Promise<{ userId: string; user: Actor; bucketName: string } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  const bucket = await buckets.getBucket(feedId, bucketId)
  if (!bucket) return { error: 'Bucket ikke fundet' }
  return { userId: g.userId, user: g.user, bucketName: bucket.name }
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function getOptimizationSettings(
  feedId: string
): Promise<{ data: svc.OptimizationSettings } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await svc.getOptimizationSettings(feedId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function saveOptimizationSettings(
  feedId: string,
  settings: svc.OptimizationSettings
): Promise<{ error?: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    await svc.saveOptimizationSettings(feedId, settings)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Optimization filters ─────────────────────────────────────────────────────

export async function getOptimizationFilters(
  feedId: string
): Promise<{ data: { include: svc.OptFilterConfig; exclude: svc.OptFilterConfig } } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await svc.getOptimizationFilters(feedId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function saveOptimizationFilters(
  feedId: string,
  include: svc.OptFilterConfig,
  exclude: svc.OptFilterConfig
): Promise<{ error?: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    await svc.saveOptimizationFilters(feedId, include, exclude)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Overlap ──────────────────────────────────────────────────────────────────

export async function getOptimizationOverlap(
  feedId: string
): Promise<{ data: OverlapSummary } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await svc.getOptimizationOverlap(feedId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Live overlap for an unsaved filter set (Scope editor preview).
export async function getOptimizationOverlapForFilters(
  feedId: string,
  include: svc.OptFilterConfig,
  exclude: svc.OptFilterConfig
): Promise<{ data: OverlapSummary } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await svc.getOptimizationOverlapForFilters(feedId, include, exclude) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Method B rules ───────────────────────────────────────────────────────────

export async function getTitleRules(
  feedId: string
): Promise<{ data: TitleRule[] } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await svc.getTitleRules(feedId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function saveTitleRule(feedId: string, rule: TitleRule): Promise<{ error?: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    await svc.saveTitleRule(feedId, rule)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function deleteTitleRule(
  feedId: string,
  productType: string
): Promise<{ error?: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    await svc.deleteTitleRule(feedId, productType)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Manual edit ──────────────────────────────────────────────────────────────

export async function saveManualTitle(
  feedId: string,
  productRef: string,
  title: string
): Promise<{ error?: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    await svc.saveManualTitle(feedId, productRef, title)
    await logTitles(g.user, feedId, 'Titel skrevet manuelt', null, title)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function runOptimization(
  feedId: string,
  method: TitleMethod,
  choice: RerunChoice
): Promise<{ data: RunResult } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    // Volume budget: charge the day's product quota by how many this run targets.
    const plan = await svc.planOptimization(feedId, choice)
    await enforceRateLimit(g.userId, 'optimize_products_daily', plan.targets.length)
    return { data: await svc.runOptimization(feedId, method, choice) }
  } catch (e) {
    return { error: clientMessage(e, 'runOptimization') }
  }
}

// Returns the refs a run would process + the overlap summary (for the UI to
// size progress and chunk the run).
export async function planOptimization(
  feedId: string,
  choice: RerunChoice
): Promise<{ data: svc.RunPlanSummary } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await svc.planOptimization(feedId, choice) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Dry run on a sample — generates titles without persisting (experimentation).
export async function previewOptimization(
  feedId: string,
  method: TitleMethod,
  limit: number
): Promise<{ data: OptimizationOutcome[] } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    await enforceRateLimit(g.userId, 'workshop_generate')
    return { data: await svc.previewOptimization(feedId, method, limit) }
  } catch (e) {
    return { error: clientMessage(e, 'previewOptimization') }
  }
}

// Runs + persists one chunk of refs (from planOptimization.targets), returning
// outcomes for incremental display.
export async function runOptimizationForRefs(
  feedId: string,
  method: TitleMethod,
  refs: string[]
): Promise<{ data: OptimizationOutcome[] } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    // Volume budget: charge this chunk's product count (accumulates over chunks).
    await enforceRateLimit(g.userId, 'optimize_products_daily', refs.length)
    return { data: await svc.runOptimizationForRefs(feedId, method, refs) }
  } catch (e) {
    return { error: clientMessage(e, 'runOptimizationForRefs') }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BUCKET ACTIONS (new bucket layer — getOwnedFeed/getOwnedBucket-guarded).
// The legacy feed-scoped actions above stay until the UI is switched over.
// ════════════════════════════════════════════════════════════════════════════

// ── Bucket CRUD ──────────────────────────────────────────────────────────────

export async function listBuckets(
  feedId: string
): Promise<{ data: buckets.BucketSummary[] } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await buckets.listBuckets(feedId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function createBucket(
  feedId: string,
  name: string,
  method: buckets.BucketMethod
): Promise<{ data: buckets.Bucket } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    const bucket = await buckets.createBucket(feedId, name, method)
    await logTitles(g.user, feedId, 'Bucket oprettet', null, name)
    return { data: bucket }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function renameBucket(
  feedId: string,
  bucketId: string,
  name: string
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.renameBucket(feedId, bucketId, name)
    if (name !== g.bucketName) await logTitles(g.user, feedId, 'Bucket omdøbt', g.bucketName, name)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function setBucketMethod(
  feedId: string,
  bucketId: string,
  method: buckets.BucketMethod
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.setBucketMethod(feedId, bucketId, method)
    await logTitles(g.user, feedId, `Metode ændret i ${g.bucketName}`, null, method === 'rule_based' ? 'Regelbaseret' : 'Automatisk')
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function deleteBucket(feedId: string, bucketId: string): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.deleteBucket(feedId, bucketId)
    await logTitles(g.user, feedId, 'Bucket slettet', g.bucketName, null)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Per-bucket filters ───────────────────────────────────────────────────────

export async function getBucketFilters(
  feedId: string,
  bucketId: string
): Promise<{ data: { include: svc.OptFilterConfig; exclude: svc.OptFilterConfig } } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await buckets.getBucketFilters(bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function saveBucketFilters(
  feedId: string,
  bucketId: string,
  include: svc.OptFilterConfig,
  exclude: svc.OptFilterConfig
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.saveBucketFilters(feedId, bucketId, include, exclude)
    const n = (c: svc.OptFilterConfig) => (c.rules ?? []).length
    await logTitles(g.user, feedId, `Scope ændret i ${g.bucketName}`, null, `${n(include)} inkludér- og ${n(exclude)} ekskludér-regler`)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Per-bucket rules ─────────────────────────────────────────────────────────

export async function getBucketRules(
  feedId: string,
  bucketId: string
): Promise<{ data: TitleRule[] } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await buckets.getBucketRules(feedId, bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function saveBucketRule(
  feedId: string,
  bucketId: string,
  rule: TitleRule
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.saveBucketRule(feedId, bucketId, rule)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function deleteBucketRule(
  feedId: string,
  bucketId: string,
  productType: string
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.deleteBucketRule(bucketId, productType)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Membership & overlap ─────────────────────────────────────────────────────

// Candidate refs from an (unsaved) filter — feed-level (no bucketId needed).
export async function getBucketCandidates(
  feedId: string,
  include: svc.OptFilterConfig,
  exclude: svc.OptFilterConfig
): Promise<{ data: string[] } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await buckets.getBucketCandidates(feedId, include, exclude) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Distinct metafields present in this feed's products (for the scope filter's
// metafield dropdown). Feed-level — no bucketId needed.
export async function getFeedMetafields(
  feedId: string
): Promise<{ data: buckets.FeedMetafield[] } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await buckets.getFeedMetafields(feedId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function getBucketOverlap(
  feedId: string,
  bucketId: string,
  candidateRefs: string[]
): Promise<
  { data: { conflicts: buckets.BucketConflict[]; inThisBucket: number; unassigned: number } } | { error: string }
> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await buckets.getBucketOverlap(feedId, bucketId, candidateRefs) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function getBucketMembership(
  feedId: string,
  bucketId: string
): Promise<{ data: string[] } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await buckets.getBucketMembership(feedId, bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function setBucketMembership(
  feedId: string,
  bucketId: string,
  refs: string[]
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.setBucketMembership(feedId, bucketId, refs)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Manual membership (additive to the filter) ───────────────────────────────

export async function getBucketManualProducts(
  feedId: string,
  bucketId: string
): Promise<{ data: { product_ref: string; title: string }[] } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await buckets.getBucketManualProducts(feedId, bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function addManualBucketProducts(
  feedId: string,
  bucketId: string,
  refs: string[]
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.addManualProducts(feedId, bucketId, refs)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function removeManualBucketProduct(
  feedId: string,
  bucketId: string,
  ref: string
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.removeManualProduct(feedId, bucketId, ref)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Feed-level product search for the manual-add picker (no bucketId needed).
export async function searchFeedProducts(
  feedId: string,
  query: string
): Promise<{ data: { product_ref: string; title: string; vendor: string | null; image_url: string | null }[] } | { error: string }> {
  const g = await requireOwnedFeed(feedId)
  if ('error' in g) return g
  try {
    return { data: await buckets.searchFeedProducts(feedId, query) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Run / preview ────────────────────────────────────────────────────────────

export async function planBucketRun(
  feedId: string,
  bucketId: string,
  choice: RerunChoice
): Promise<{ data: { targets: string[]; summary: OverlapSummary } } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await buckets.planBucketRun(feedId, bucketId, choice) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function runBucketRefs(
  feedId: string,
  bucketId: string,
  refs: string[]
): Promise<{ data: OptimizationOutcome[] } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    // Volume budget: charge this chunk's product count (accumulates over chunks).
    await enforceRateLimit(g.userId, 'optimize_products_daily', refs.length)
    return { data: await buckets.runBucketRefs(feedId, bucketId, refs) }
  } catch (e) {
    return { error: clientMessage(e, 'runBucketRefs') }
  }
}


// ── Custom labels (split-testing) ────────────────────────────────────────────

export async function getBucketCustomLabel(
  feedId: string,
  bucketId: string
): Promise<{ data: { index: number | null; value: string; conflicts: number[] } } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    const [bucket, conflicts] = await Promise.all([
      buckets.getBucket(feedId, bucketId),
      buckets.getFeedCustomLabelConflicts(feedId),
    ])
    return {
      data: {
        index: bucket?.custom_label_index ?? null,
        value: bucket?.custom_label_value ?? '',
        conflicts,
      },
    }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function setBucketCustomLabel(
  feedId: string,
  bucketId: string,
  index: number | null,
  value: string | null
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await buckets.setBucketCustomLabel(feedId, bucketId, index, value)
    await logTitles(
      g.user,
      feedId,
      `Custom label ændret i ${g.bucketName}`,
      null,
      index === null || !value ? 'Ingen' : `custom_label_${index} = ${value}`
    )
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Results (whole bucket + optimization state) ──────────────────────────────

export async function listBucketResults(
  feedId: string,
  bucketId: string
): Promise<{ data: svc.ResultItem[] } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await svc.listBucketResults(feedId, bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function getBucketProductDetail(
  feedId: string,
  bucketId: string,
  productRef: string
): Promise<{ data: svc.ProductDetail } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await svc.getBucketProductDetail(feedId, productRef) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Review (needs_review queue) ──────────────────────────────────────────────

export async function listBucketReview(
  feedId: string,
  bucketId: string
): Promise<{ data: svc.ReviewItem[] } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await svc.listBucketReview(feedId, bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Accept (with the proposed title) or save an edited title for a reviewed
// product — both are human overrides → status 'human_edited'.
export async function saveBucketReviewTitle(
  feedId: string,
  bucketId: string,
  productRef: string,
  title: string
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await svc.saveManualTitle(feedId, productRef, title)
    await logTitles(g.user, feedId, `Titel godkendt i ${g.bucketName}`, null, title)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// Reject a proposal — lock the product to its original title.
export async function rejectBucketReview(
  feedId: string,
  bucketId: string,
  productRef: string
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await svc.rejectOptimization(feedId, productRef)
    await logTitles(g.user, feedId, `AI-titel afvist i ${g.bucketName}`, null, `Vare ${productRef} beholder sin titel`)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

// ── Example workshop (per-bucket few-shot curation) ──────────────────────────

export async function getBucketTitleConfig(
  feedId: string,
  bucketId: string
): Promise<{ data: workshop.BucketTitleConfig } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await workshop.getBucketTitleConfig(bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function saveBucketTitleConfig(
  feedId: string,
  bucketId: string,
  config: workshop.BucketTitleConfig
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await workshop.saveBucketTitleConfig(feedId, bucketId, config)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function listBucketExamples(
  feedId: string,
  bucketId: string
): Promise<{ data: workshop.BucketExample[] } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await workshop.listBucketExamples(bucketId) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function generateBucketCandidates(
  feedId: string,
  bucketId: string
): Promise<{ data: workshop.GenerateResult } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await enforceRateLimit(g.userId, 'workshop_generate')
    return { data: await workshop.generateBucketCandidates(feedId, bucketId) }
  } catch (e) {
    return { error: clientMessage(e, 'generateBucketCandidates') }
  }
}

// The workshop's round-header context (original title + resolved input-field
// values) for the one product all five candidates are titled from.
export async function getRoundProductContext(
  feedId: string,
  bucketId: string,
  productRef: string
): Promise<{ data: workshop.RoundProductContext } | { error: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    return { data: await workshop.getRoundProductContext(feedId, bucketId, productRef) }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function setBucketExampleStatus(
  feedId: string,
  bucketId: string,
  exampleId: string,
  status: workshop.ExampleStatus
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await workshop.setExampleStatus(feedId, bucketId, exampleId, status)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function updateBucketExampleNote(
  feedId: string,
  bucketId: string,
  exampleId: string,
  note: string
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await workshop.updateExampleNote(feedId, bucketId, exampleId, note)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}

export async function deleteBucketExample(
  feedId: string,
  bucketId: string,
  exampleId: string
): Promise<{ error?: string }> {
  const g = await requireOwnedBucket(feedId, bucketId)
  if ('error' in g) return g
  try {
    await workshop.deleteExample(feedId, bucketId, exampleId)
    return {}
  } catch (e) {
    return { error: (e as Error).message }
  }
}
