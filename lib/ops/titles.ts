// AI Titles: changes shared with the MCP tools.
//
// The work is done by the same services as the AI Titles page
// (lib/optimizationBuckets, lib/titleOptimizationService, lib/bucketExamples);
// these add the Activity log lines the page's actions write, and do the steps
// the page does in sequence (saving a scope also updates which products the
// bucket holds; running goes in chunks within the daily AI budget).

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { AppError, clientMessage } from '@/lib/errors'
import { enforceRateLimit } from '@/lib/rateLimit'
import * as buckets from '@/lib/optimizationBuckets'
import * as svc from '@/lib/titleOptimizationService'
import * as workshop from '@/lib/bucketExamples'
import type { OpContext, OpResult } from '@/lib/ops/feedConfig'

export type TitleBucketInput = { id?: string; name?: string; method?: buckets.BucketMethod }
export type TitleDecision = { product_ref: string; action: 'approve' | 'reject'; title?: string }

/** Most products one approved run handles; more means another proposal. */
export const MAX_RUN_PRODUCTS = 100
const RUN_CHUNK = 10 // same chunk size as the AI Titles page

const message = (err: unknown, context: string) => (err instanceof AppError ? err.message : clientMessage(err, context))
const METHOD_LABEL: Record<buckets.BucketMethod, string> = { auto: 'Automatic', rule_based: 'Rule-based' }

async function log(db: SupabaseClient, ctx: OpContext, feedId: string, action: string, before?: string | null, after?: string | null) {
  await logActivity(db, { user: ctx.user, via: ctx.via, feedId, area: 'AI Titles', action, before, after })
}

async function bucketOf(feedId: string, bucketId: string) {
  const b = await buckets.getBucket(feedId, bucketId)
  if (!b) throw new AppError('Bucket not found')
  return b
}

export async function applyTitleBucketSave(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  input: TitleBucketInput
): Promise<OpResult> {
  try {
    if (!input.id) {
      const created = await buckets.createBucket(feedId, input.name ?? '', input.method ?? 'auto')
      await log(db, ctx, feedId, 'Bucket created', null, created.name)
      return {}
    }
    const b = await bucketOf(feedId, input.id)
    if (input.name !== undefined && input.name.trim() !== b.name) {
      await buckets.renameBucket(feedId, b.id, input.name)
      await log(db, ctx, feedId, 'Bucket renamed', b.name, input.name.trim())
    }
    if (input.method && input.method !== b.method) {
      await buckets.setBucketMethod(feedId, b.id, input.method)
      await log(db, ctx, feedId, `Method changed in ${b.name}`, null, METHOD_LABEL[input.method])
    }
    return {}
  } catch (err) {
    return { error: message(err, 'applyTitleBucketSave') }
  }
}

// Saves the bucket's scope and, like the page, sets its products to what the
// scope matches — leaving products that already belong to another bucket there.
export async function applyTitleScope(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  bucketId: string,
  include: svc.OptFilterConfig,
  exclude: svc.OptFilterConfig
): Promise<OpResult> {
  try {
    const b = await bucketOf(feedId, bucketId)
    await buckets.saveBucketFilters(feedId, bucketId, include, exclude)
    const candidates = await buckets.getBucketCandidates(feedId, include, exclude)
    const overlap = await buckets.getBucketOverlap(feedId, bucketId, candidates)
    const elsewhere = new Set(overlap.conflicts.map((c) => c.product_ref))
    const refs = candidates.filter((r) => !elsewhere.has(r))
    await buckets.setBucketMembership(feedId, bucketId, refs)
    const n = (c: svc.OptFilterConfig) => (c.rules ?? []).length
    await log(db, ctx, feedId, `Scope changed in ${b.name}`, null, `${n(include)} include and ${n(exclude)} exclude rules, ${refs.length} products`)
    return {}
  } catch (err) {
    return { error: message(err, 'applyTitleScope') }
  }
}

export async function applyTitleConfig(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  bucketId: string,
  config: workshop.BucketTitleConfig
): Promise<OpResult> {
  try {
    const b = await bucketOf(feedId, bucketId)
    const prev = await workshop.getBucketTitleConfig(bucketId)
    await workshop.saveBucketTitleConfig(feedId, bucketId, config)
    await log(db, ctx, feedId, `Instructions changed in ${b.name}`, prev.instructions || null, config.instructions || null)
    return {}
  } catch (err) {
    return { error: message(err, 'applyTitleConfig') }
  }
}

// Approve (the proposed title, or an edited one) or reject titles waiting for
// review — the same as the review queue on the AI Titles page.
export async function applyTitleReview(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  bucketId: string,
  decisions: TitleDecision[]
): Promise<OpResult> {
  try {
    const b = await bucketOf(feedId, bucketId)
    const queue = new Map((await svc.listBucketReview(feedId, bucketId)).map((r) => [r.product_ref, r]))
    const skipped: string[] = []
    for (const d of decisions) {
      const item = queue.get(d.product_ref)
      if (!item) {
        skipped.push(d.product_ref)
        continue
      }
      if (d.action === 'reject') {
        await svc.rejectOptimization(feedId, d.product_ref)
        await log(db, ctx, feedId, `AI title rejected in ${b.name}`, null, `Product ${d.product_ref} keeps its title`)
      } else {
        const title = (d.title ?? item.proposed_title ?? '').trim()
        if (!title) {
          skipped.push(d.product_ref)
          continue
        }
        await svc.saveManualTitle(feedId, d.product_ref, title)
        await log(db, ctx, feedId, `Title approved in ${b.name}`, null, title)
      }
    }
    return skipped.length
      ? { warnings: [`Not in the review queue any more, skipped: ${skipped.join(', ')}`] }
      : {}
  } catch (err) {
    return { error: message(err, 'applyTitleReview') }
  }
}

// Generates AI titles for the bucket's products that have none yet (or all of
// them on a re-run; titles edited by hand are never overwritten), at most
// MAX_RUN_PRODUCTS, in the page's chunk size and within the daily AI budget.
export async function applyTitleRun(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  bucketId: string,
  opts: { rerun: boolean; limit: number }
): Promise<OpResult> {
  try {
    const b = await bucketOf(feedId, bucketId)
    const plan = await buckets.planBucketRun(feedId, bucketId, { rerun: opts.rerun, includeHumanEdited: false })
    const targets = plan.targets.slice(0, Math.min(opts.limit, MAX_RUN_PRODUCTS))
    if (targets.length === 0) return { warnings: ['Nothing to generate: every product in the bucket already has a title.'] }
    let ok = 0
    let review = 0
    for (let i = 0; i < targets.length; i += RUN_CHUNK) {
      const chunk = targets.slice(i, i + RUN_CHUNK)
      await enforceRateLimit(ctx.user.id, 'optimize_products_daily', chunk.length)
      const outcomes = await buckets.runBucketRefs(feedId, bucketId, chunk)
      for (const o of outcomes) {
        if (o.validation.ok) ok++
        else review++
      }
    }
    await log(db, ctx, feedId, `AI titles generated in ${b.name}`, null, `${targets.length} products: ${ok} ready, ${review} need review`)
    const left = plan.targets.length - targets.length
    return left > 0 ? { warnings: [`${left} products in the bucket still have no title; ask again to continue.`] } : {}
  } catch (err) {
    return { error: message(err, 'applyTitleRun') }
  }
}
