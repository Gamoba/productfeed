// Per-bucket example workshop (migration 025).
//
// Few-shot examples moved from per-feed (title_optimization_settings.few_shot_examples)
// to per-BUCKET. A bucket owns:
//   - bucket_title_config: free-text instructions + chosen input-field tokens.
//   - bucket_examples: every candidate ever generated, status approved | rejected
//     | candidate. The approved rows (up to 5, fewer fine) are the few-shot; the
//     rest are dialog history that conditions the next generation round.
//
// The workshop is RESUMABLE — all state lives in those two tables, so the user
// can leave and pick up where they left off. Generation builds an Anthropic
// message history (prior candidates + the user's approve/reject verdict + notes)
// so the model learns the pattern across rounds: "these were good, these weren't
// — make more like the good ones."
//
// Model/temperature mirror lib/titleOptimizer (haiku-4-5 / 0.3): temperature 0.3
// is required and only available on temperature-supporting models, and Haiku is
// the tier already used for the per-product run. This module is the headless
// service; ownership (getOwnedFeed/requireOwnedBucket) is enforced at the action
// layer, and feed_id is carried on every row/query as a scoping belt.

import Anthropic from '@anthropic-ai/sdk'
import { adminDb } from '@/lib/feeds'
import type { SupabaseProduct } from '@/lib/sync'
import { resolveField } from '@/lib/feedFilters'
import { dbError } from '@/lib/errors'
import { getBucketMembership } from '@/lib/optimizationBuckets'
import { getMetafieldNameMap } from '@/lib/metafieldDefinitions'
import {
  createOptimizerClient,
  toOptimizerProduct,
  validateResult,
  localeToLanguage,
  mandatoryInstructionBlock,
  instructionComplianceReminder,
  fieldDisplayLabel,
  dedupeLabels,
  DEFAULT_CHAR_LIMIT,
  type ValidationResult,
} from '@/lib/titleOptimizer'

const IN_CHUNK = 200 // cap .in() list size to stay under URL limits
const MODEL = 'claude-haiku-4-5'
const TEMPERATURE = 0.3
export const MAX_APPROVED = 5 // few-shot ceiling; fewer is fine
export const APPROACHES_PER_ROUND = 5 // each round = 5 deliberately different approaches

// Fixed taxonomy of titling strategies. Each round asks for one candidate per
// DISTINCT strategy — variation is imposed structurally (a strategy per slot),
// not left to the model's whim. The model picks which strategies to use and
// labels each candidate with the one it applied.
export const STRATEGIES: { id: string; description: string }[] = [
  { id: 'search_intent', description: 'phrased the way shoppers actually search — search-intent keywords first' },
  { id: 'spec_heavy', description: 'specification-heavy — key attributes (vintage, region, grape, model) front-loaded' },
  { id: 'concise', description: 'short and precise — brand and core identity/appellation only' },
  // Format variation: a hyphen separator structures long titles. Placed among the
  // first five so a single round's spread spans formats (spaces, hyphen, short,
  // spec-heavy) rather than waiting for a later round.
  { id: 'hyphen_separated', description: 'hyphen-structured for readability — group the primary specs (e.g. brand/appellation + vintage) first, then secondary specs (e.g. producer) after a plain hyphen "-", e.g. "Nebbiolo Ghemme 1999 - Antichi Vigneti di Cantalupo"; still pure specs separated by the hyphen, NEVER connective words ("from", "by", "with")' },
  { id: 'attribute_rich', description: 'long and attribute-rich — include every available wished-for attribute' },
  { id: 'brand_vintage', description: 'brand- and vintage-centred — producer + year lead the title' },
  { id: 'category_first', description: 'product type / category leads, then brand and attributes' },
  { id: 'region_first', description: 'origin/appellation/region leads, then producer and attributes' },
  { id: 'varietal_first', description: 'grape variety / model / material leads, then brand and origin' },
  { id: 'title_case', description: 'same specs, normalised to consistent Title Case so ALL-CAPS source values (e.g. shouty producer names) read evenly — reformats casing only, adds/removes/translates nothing' },
]

// Picks `count` DISTINCT strategy ids for a round, preferring ones NOT already in
// the approved set (so new rounds explore fresh territory), filling with covered
// ones only if the taxonomy can't supply enough fresh ones. Pure/testable.
export function pickRoundStrategies(coveredApproaches: string[], count: number): string[] {
  const covered = new Set(coveredApproaches.filter(Boolean))
  const ids = STRATEGIES.map((s) => s.id)
  const fresh = ids.filter((id) => !covered.has(id))
  const reused = ids.filter((id) => covered.has(id))
  return [...fresh, ...reused].slice(0, Math.max(0, count))
}

// ── Types ────────────────────────────────────────────────────────────────────

export type ExampleStatus = 'approved' | 'rejected' | 'candidate'

export type BucketExample = {
  id: string
  bucket_id: string
  product_ref: string
  generated_title: string
  status: ExampleStatus
  note: string
  approach: string // strategy id the model used (e.g. "spec_heavy"); '' for legacy rows
  rationale: string // one-sentence AI explanation of how the title was built
  position: number | null
  created_at: string
}

export type BucketTitleConfig = {
  instructions: string
  input_fields: string[] // field tokens (standard fields + metafield:ns.key)
}

// A freshly generated candidate, with the grounding/validation verdict attached
// for the UI (not persisted — examples are re-validated only if needed).
export type GeneratedCandidate = BucketExample & { validation: ValidationResult }

export type GenerateResult = {
  // All candidates in one round share a single product_ref — they are the SAME
  // product titled with different strategies, for a clean strategy comparison.
  candidates: GeneratedCandidate[]
  // Unused members remaining after this round (members with no example row yet).
  // Approximate — counts members regardless of field-eligibility — so the UI can
  // show roughly how much catalogue is left to draw from.
  unusedMembersAfter: number
}

function db() {
  return adminDb()
}

// ── Title config (per bucket) ────────────────────────────────────────────────

export async function getBucketTitleConfig(bucketId: string): Promise<BucketTitleConfig> {
  const { data } = await db()
    .from('bucket_title_config')
    .select('instructions, input_fields')
    .eq('bucket_id', bucketId)
    .maybeSingle()
  return {
    instructions: (data?.instructions as string | undefined) ?? '',
    input_fields: (data?.input_fields as string[] | undefined) ?? [],
  }
}

export async function saveBucketTitleConfig(
  feedId: string,
  bucketId: string,
  config: BucketTitleConfig
): Promise<void> {
  const { error } = await db()
    .from('bucket_title_config')
    .upsert(
      {
        feed_id: feedId,
        bucket_id: bucketId,
        instructions: config.instructions,
        input_fields: config.input_fields,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'bucket_id' }
    )
  if (error) dbError('bucketExamples', error)
}

// ── Examples CRUD ────────────────────────────────────────────────────────────

// All examples for a bucket. Approved first (by position), then the rest newest
// first — the shape the workshop UI and the dialog history both want.
export async function listBucketExamples(bucketId: string): Promise<BucketExample[]> {
  const { data } = await db()
    .from('bucket_examples')
    .select('id, bucket_id, product_ref, generated_title, status, note, approach, rationale, position, created_at')
    .eq('bucket_id', bucketId)
  const rows = ((data ?? []) as BucketExample[]).map((r) => ({
    ...r,
    note: r.note ?? '',
    approach: r.approach ?? '',
    rationale: r.rationale ?? '',
  }))
  return rows.sort((a, b) => {
    if (a.status === 'approved' && b.status === 'approved') return (a.position ?? 0) - (b.position ?? 0)
    if (a.status === 'approved') return -1
    if (b.status === 'approved') return 1
    return b.created_at.localeCompare(a.created_at)
  })
}

// The workshop's round-header context: the product's original (source) title plus
// the RESOLVED values of the bucket's selected input fields, in priority order.
// Values come from the SAME resolveField + market_url path as buildProductPayload
// (so they match the actual generation input and the product-detail view — GIDs
// are already labels after sync), keeping only non-empty fields. Labels are left
// to the client (fieldLabel) so the names match the rest of the workshop UI.
export type RoundProductContext = {
  title: string
  fields: { token: string; value: string }[]
}

export async function getRoundProductContext(
  feedId: string,
  bucketId: string,
  productRef: string
): Promise<RoundProductContext> {
  const [config, { data: ss }, { data: prod }] = await Promise.all([
    getBucketTitleConfig(bucketId),
    db().from('shop_settings').select('market_url').eq('feed_id', feedId).maybeSingle(),
    db()
      .from('products')
      .select('*, metafields:product_metafields(*)')
      .eq('feed_id', feedId)
      .eq('shopify_id', productRef)
      .maybeSingle(),
  ])
  if (!prod) return { title: '', fields: [] }

  const marketUrl = (ss?.market_url as string | null) ?? null
  const p = prod as SupabaseProduct
  // Only the user's chosen input fields, in their priority order, non-empty.
  const fields: { token: string; value: string }[] = []
  for (const token of config.input_fields) {
    const v = resolveField(token, p, marketUrl)
    if (v && v.trim()) fields.push({ token, value: v.trim() })
  }
  return { title: p.title ?? '', fields }
}

// Smallest free approved slot in [0, max). Pure so it's unit-testable.
export function nextApprovedPosition(used: Iterable<number>, max = MAX_APPROVED): number | null {
  const taken = new Set(used)
  for (let p = 0; p < max; p++) if (!taken.has(p)) return p
  return null
}

// Approve / reject / un-curate a candidate. Approving assigns the next free slot
// and enforces the MAX_APPROVED ceiling; any other status clears the position.
export async function setExampleStatus(
  feedId: string,
  bucketId: string,
  exampleId: string,
  status: ExampleStatus
): Promise<void> {
  if (status === 'approved') {
    const { data: approved } = await db()
      .from('bucket_examples')
      .select('id, position')
      .eq('bucket_id', bucketId)
      .eq('status', 'approved')
    const rows = (approved ?? []) as { id: string; position: number | null }[]
    if (rows.some((r) => r.id === exampleId)) return // already approved — no-op
    if (rows.length >= MAX_APPROVED) {
      throw new Error(`At most ${MAX_APPROVED} approved examples. Delete one to free up a slot`)
    }
    const position = nextApprovedPosition(rows.map((r) => r.position ?? 0))
    const { error } = await db()
      .from('bucket_examples')
      .update({ status, position })
      .eq('id', exampleId)
      .eq('feed_id', feedId)
      .eq('bucket_id', bucketId)
    if (error) dbError('bucketExamples', error)
    return
  }

  const { error } = await db()
    .from('bucket_examples')
    .update({ status, position: null })
    .eq('id', exampleId)
    .eq('feed_id', feedId)
    .eq('bucket_id', bucketId)
  if (error) dbError('bucketExamples', error)
}

export async function updateExampleNote(
  feedId: string,
  bucketId: string,
  exampleId: string,
  note: string
): Promise<void> {
  const { error } = await db()
    .from('bucket_examples')
    .update({ note })
    .eq('id', exampleId)
    .eq('feed_id', feedId)
    .eq('bucket_id', bucketId)
  if (error) dbError('bucketExamples', error)
}

// Deletes an example. On an approved row this frees a slot; on a candidate/reject
// it drops it from the dialog history.
export async function deleteExample(feedId: string, bucketId: string, exampleId: string): Promise<void> {
  const { error } = await db()
    .from('bucket_examples')
    .delete()
    .eq('id', exampleId)
    .eq('feed_id', feedId)
    .eq('bucket_id', bucketId)
  if (error) dbError('bucketExamples', error)
}

// ── Candidate generation ─────────────────────────────────────────────────────

// Brand + type are the universal title backbone; either one (or any chosen
// field) is enough structured data to build a meaningful title from.
const CORE_FIELDS = ['vendor', 'product_type']

// "Enough data for a meaningful title": a non-empty current title AND at least
// one non-empty structured attribute among {vendor, product_type} ∪ the selected
// input fields. The selected fields are a WISH LIST, not a requirement — a
// missing wished-for field never disqualifies a product (vendor/product_type can
// carry it). Empty field list → still requires a core attribute.
export function productHasEnoughData(p: SupabaseProduct, fields: string[], marketUrl: string | null): boolean {
  if (!(p.title ?? '').trim()) return false
  const probe = [...new Set([...CORE_FIELDS, ...fields])]
  return probe.some((f) => {
    const v = resolveField(f, p, marketUrl)
    return !!(v && v.trim())
  })
}

// The value-only payload sent to the model for one product: its ref, the current
// title (rewrite source), and the resolved values of the chosen input fields,
// keyed by their HUMAN label (via `label`) so the keys match the wish-list and
// the instruction's wording. Only present fields are included ("include if
// possible"), iterated in priority order so the payload's key order also reflects
// the wish list's ranking.
function buildProductPayload(
  p: SupabaseProduct,
  fields: string[],
  label: (token: string) => string,
  marketUrl: string | null
) {
  const resolved: Record<string, string> = {}
  for (const f of fields) {
    const v = resolveField(f, p, marketUrl)
    if (v && v.trim()) resolved[label(f)] = v
  }
  return { product_ref: p.shopify_id, current_title: p.title ?? '', fields: resolved }
}

// Stable, cacheable system prompt. The bucket's instructions + char limit +
// target language are part of it (stable within one workshop session); the
// per-round products and the approve/reject verdict live in the messages.
export function buildWorkshopSystemPrompt(
  instructions: string,
  charLimit: number,
  targetLanguage: string,
  inputFieldLabels: string[] = []
): string {
  // The selected fields are a prioritised INCLUSION wish list — keyed by the same
  // HUMAN labels used as keys in each product's `fields` payload, so the model can
  // correlate them (and bind the user instruction's wording to the data). Order =
  // inclusion priority, NOT placement. Omitted entirely when no fields are selected.
  const wishList = inputFieldLabels.length
    ? `

# Attributes to include — ranked by INCLUSION priority, NOT placement
These are the attributes worth including, ranked by how important they are to KEEP. This ranking ONLY decides what makes the cut when space is tight (keep the higher-ranked, drop the lower-ranked to stay under the character limit) — it does NOT decide where anything goes in the title. Placement and order are governed by the MANDATORY USER INSTRUCTION above. Each name below matches a key in the product's "fields" data. Include each ONLY if it is present for that product; if it is missing, simply skip it — NEVER invent it:
${dedupeLabels(inputFieldLabels).map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : ''

  // Same hard instruction block + compliance reminder as the real run
  // (titleOptimizer.buildSystemPrompt) so the workshop and the run share DNA.
  const mandatory = mandatoryInstructionBlock(instructions)
  const mandatoryBlock = mandatory ? `\n\n${mandatory}` : ''
  const reminder = instructionComplianceReminder(instructions)

  return `You are a product title optimizer for Google Shopping feeds. You generate CANDIDATE titles for a human curator who will pick the best ones as reference examples. Rewrite each product's title so it ranks well in Google Shopping search and matches how shoppers search — while staying 100% truthful to the source data.${mandatoryBlock}

# Title rules
- Structure: Brand → Product type → Key attributes (color, material, size, volume, vintage, model) → Variant. Most searchable terms first.
- Front-load the most important keywords; stay under ${charLimit} characters total.
- Language: write the title in ${targetLanguage}, using natural phrasing a native speaker would search for — not a literal translation.
- No promotional/subjective language: no "best", "sale", "cheap", "free shipping", "%", "!".
- No ALL-CAPS words (except acronyms/units like ABV, ml, cl).

# Grounding (critical — never violate)
- Use ONLY attributes explicitly present in each product's data. NEVER invent or guess an attribute.
- NEVER add a measurement (ml, cl, l, kg, g) unless that exact value is in the data.
- If data is thin, produce a SHORTER but accurate title rather than padding with assumptions.
${wishList}

# Titling strategies — vary the METHOD, not just the words
You generate several candidates at once. Each candidate MUST use a DIFFERENT strategy from this list — never repeat a strategy within one response. Vary the approach to building the title, not just the wording:
${STRATEGIES.map((s) => `- ${s.id}: ${s.description}`).join('\n')}

How the strategies interact with the MANDATORY USER INSTRUCTION (read carefully):
EVERY candidate must obey the instruction on EVERY title — it is NOT the dimension that varies between strategies. The instruction fixes the ARRANGEMENT (an element first, an element last, or a fixed order — whatever it says); each strategy then only decides how to select and arrange the REMAINING, unpinned elements. A strategy whose name implies an arrangement that conflicts with the instruction — e.g. varietal_first when the instruction puts the grape LAST, or spec_heavy / region_first / brand_vintage front-loading an element the instruction pins elsewhere — must YIELD to the instruction: keep the instruction's placement and express the strategy only through the unpinned remainder. The candidates stay distinct by how they treat that remainder, NEVER by breaking the instruction.
The principle is the SAME whatever the instruction says — examples:
- instruction "grape last" + region_first → "<region> <rest> … <grape>" (the grape ENDS the title; the region leads the rest)
- instruction "grape last" + brand_vintage → "<producer> <year> <rest> … <grape>"
- instruction "vintage first" + region_first → "<year> <region> <rest>"
- instruction "year, then grape, then region" → every title "<year> <grape> <region> <rest>"; the strategy varies only <rest>
Grounding still wins over the instruction: if a pinned element is ABSENT for this product (e.g. no grape in the data), do NOT invent it — apply the instruction as far as the data allows, then arrange the rest per the strategy.

# Output — return ONLY a JSON array, no preamble. One object per candidate — ALL candidates are for the one product, so every object echoes that SAME product_ref:${reminder}
[{ "product_ref": "...", "approach": "<one strategy id from the list>", "rationale": "<one short sentence>", "title": "...", "source_values": ["..."] }]
- "approach": the strategy id you applied — must be one from the list above, and DISTINCT across the array.
- "rationale": one short sentence in ENGLISH (always English, regardless of the title's language — it is an internal note for the human curator and NEVER appears in the feed) describing how the ${targetLanguage} title is built. It must NEVER justify an attribute that is not in the product's data.
- "source_values": the factual values you took from the product data and placed in the title, written EXACTLY as they appear in the data, in the source language (NOT translated). Do not list the generic product type or any inferred/translated word.`
}

type ParsedCandidate = {
  product_ref?: string
  approach: string
  rationale: string
  title: string
  source_values: string[]
}

// Tolerant JSON-array extraction (mirrors titleOptimizer.parseRawResult but for
// an array). Strips ``` fences and pulls the first [...] block.
export function parseCandidatesArray(text: string): ParsedCandidate[] | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const arr = JSON.parse(cleaned.slice(start, end + 1))
    if (!Array.isArray(arr)) return null
    return arr
      .filter((o) => o && typeof o.title === 'string')
      .map((o) => ({
        product_ref: typeof o.product_ref === 'string' ? o.product_ref : undefined,
        approach: typeof o.approach === 'string' ? o.approach.trim() : '',
        rationale: typeof o.rationale === 'string' ? o.rationale.trim() : '',
        title: (o.title as string).trim(),
        source_values: Array.isArray(o.source_values)
          ? o.source_values.filter((s: unknown): s is string => typeof s === 'string')
          : [],
      }))
  } catch {
    return null
  }
}

// Divergence signal: the approved examples are COVERED ground. We replay them so
// the model produces NEW approaches that differ from them — it drives exploration,
// it does NOT ask the model to converge toward the curator's taste (that happens
// later, at the run, where approved examples are the few-shot). Pure/testable.
export function buildDivergenceBlock(examples: BucketExample[]): string {
  const approved = examples.filter((e) => e.status === 'approved')
  if (!approved.length) return ''
  const lines = approved.map((e) => `- "${e.generated_title}"${e.approach ? ` [${e.approach}]` : ''}`)
  const coveredApproaches = [...new Set(approved.map((e) => e.approach).filter(Boolean))]
  let block =
    `The curator has already APPROVED the examples below — this is covered ground. Produce NEW candidates whose approaches are genuinely DIFFERENT from these; do NOT converge toward them or repeat their style:\n${lines.join('\n')}`
  if (coveredApproaches.length) {
    block += `\nApproaches already covered (avoid repeating these where possible): ${coveredApproaches.join(', ')}.`
  }
  return `${block}\n`
}

// Builds the message for a round: a single user turn carrying the divergence
// signal (when there are approved examples) plus the ask. Strategies are ASSIGNED
// (one per candidate) so the round's distinctness is guaranteed structurally, not
// left to the model. All candidates are titled on the SAME single product so the
// curator compares strategies, not products — `payloads` carries that one product
// (single-element list). The taxonomy + output format live in the cached system
// prompt. messages[0] is a user turn.
export function buildWorkshopMessages(
  examples: BucketExample[],
  payloads: ReturnType<typeof buildProductPayload>[],
  strategies: string[],
  targetLanguage: string
): Anthropic.MessageParam[] {
  const divergence = buildDivergenceBlock(examples)
  const ask =
    (divergence ? `${divergence}\n` : '') +
    `Produce exactly ${strategies.length} candidate titles, ALL for the SAME single product below — one title per strategy, EXACTLY ONE candidate per strategy: ${strategies.join(', ')}. Every candidate must echo the product's product_ref and set its "approach" to the strategy used. Target language: ${targetLanguage}.\nProduct: ${JSON.stringify(payloads[0] ?? null)}`
  return [{ role: 'user', content: ask }]
}

// Generates one round = up to APPROACHES_PER_ROUND (5) candidates, ALL titled on
// ONE single product with DISTINCT strategies, and persists them as 'candidate'
// rows. Titling the same product means the curator compares the STRATEGY, not the
// product. First resolves any leftover candidates from the previous round to
// 'rejected' (the curator moved on without picking them — implicit "not these"),
// so only the current round's candidates are live. Replays the APPROVED examples
// as covered ground so the model diverges instead of converging.
//
// The chosen product gets APPROACHES_PER_ROUND example rows (all sharing its
// product_ref), so it lands in `usedRefs` and the NEXT round automatically picks a
// fresh product — no extra round-to-round bookkeeping needed.
export async function generateBucketCandidates(
  feedId: string,
  bucketId: string
): Promise<GenerateResult> {
  // Previous round's un-chosen candidates → rejected (implicit "not these").
  await db()
    .from('bucket_examples')
    .update({ status: 'rejected', position: null })
    .eq('bucket_id', bucketId)
    .eq('status', 'candidate')

  const [config, examples, memberRefs, { data: ss }, { data: settings }, nameMap] = await Promise.all([
    getBucketTitleConfig(bucketId),
    listBucketExamples(bucketId),
    getBucketMembership(feedId, bucketId),
    db().from('shop_settings').select('market_url, selected_locale').eq('feed_id', feedId).maybeSingle(),
    db().from('title_optimization_settings').select('char_limit').eq('feed_id', feedId).maybeSingle(),
    getMetafieldNameMap(feedId), // token → human name, so the prompt/payload bind to the instruction
  ])

  const marketUrl = (ss?.market_url as string | null) ?? null
  const targetLanguage = localeToLanguage((ss?.selected_locale as string | null) ?? null)
  const charLimit = (settings?.char_limit as number | undefined) ?? DEFAULT_CHAR_LIMIT
  const label = (token: string) => fieldDisplayLabel(token, nameMap)

  // Members that don't already have an example row.
  const usedRefs = new Set(examples.map((e) => e.product_ref))
  const candidateRefs = memberRefs.filter((r) => !usedRefs.has(r))

  // Pick the FIRST eligible product (membership order) — deterministic and not yet
  // used. Fields are a wish list: a missing one no longer disqualifies. The whole
  // round titles this one product.
  let product: SupabaseProduct | null = null
  for (let i = 0; i < candidateRefs.length && !product; i += IN_CHUNK) {
    const slice = candidateRefs.slice(i, i + IN_CHUNK)
    const { data, error } = await db()
      .from('products')
      .select('*, metafields:product_metafields(*)')
      .eq('feed_id', feedId)
      .in('shopify_id', slice)
    if (error) dbError('bucketExamples products', error)
    // Preserve membership order within the slice (the .in() result order isn't
    // guaranteed) so "first eligible" is stable.
    const bySlice = new Map(((data ?? []) as SupabaseProduct[]).map((p) => [p.shopify_id, p]))
    for (const ref of slice) {
      const p = bySlice.get(ref)
      if (p && productHasEnoughData(p, config.input_fields, marketUrl)) {
        product = p
        break
      }
    }
  }

  if (!product) {
    throw new Error(
      'No suitable products left to generate suggestions from (products in the bucket that are not already used and have a title plus at least one attribute).'
    )
  }

  const payload = buildProductPayload(product, config.input_fields, label, marketUrl)
  const systemPrompt = buildWorkshopSystemPrompt(
    config.instructions,
    charLimit,
    targetLanguage,
    config.input_fields.map(label)
  )
  // Assign one distinct strategy per candidate, preferring approaches not already
  // approved (fresh-first), so the round is structurally distinct and divergent.
  const coveredApproaches = examples.filter((e) => e.status === 'approved').map((e) => e.approach)
  const strategies = pickRoundStrategies(coveredApproaches, APPROACHES_PER_ROUND)
  const messages = buildWorkshopMessages(examples, [payload], strategies, targetLanguage)

  const client: Anthropic = createOptimizerClient()
  const msg = await client.messages.create({
    model: MODEL,
    // One title + rationale per strategy, all for the one product — size by the
    // number of strategies asked for, not the (single) product.
    max_tokens: Math.min(200 * strategies.length + 300, 4096),
    temperature: TEMPERATURE,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  })
  const block = msg.content[0]
  if (!block || block.type !== 'text') throw new Error('Empty response from the model')
  const parsed = parseCandidatesArray(block.text)
  if (!parsed) throw new Error('Could not parse the model’s JSON response')

  // All candidates are for the one product. Run grounding validation and persist
  // as candidate rows, keeping at most one per DISTINCT approach (the round's
  // structural distinctness) and capping at APPROACHES_PER_ROUND.
  const op = toOptimizerProduct(product)
  const seenApproaches = new Set<string>()
  const rows: {
    feed_id: string
    bucket_id: string
    product_ref: string
    generated_title: string
    status: ExampleStatus
    approach: string
    rationale: string
  }[] = []
  const validations: ValidationResult[] = []
  for (const c of parsed) {
    if (rows.length >= APPROACHES_PER_ROUND) break
    if (!c.title) continue
    // Dedupe by approach so two candidates don't collapse the round; an empty
    // approach label is kept (uniquely) rather than dropped.
    const approachKey = c.approach || `__blank_${rows.length}`
    if (seenApproaches.has(approachKey)) continue
    seenApproaches.add(approachKey)
    const validation = validateResult({ title: c.title, source_values: c.source_values }, op, {
      charLimit,
      targetLanguage,
      fewShotExamples: '',
    })
    rows.push({
      feed_id: feedId,
      bucket_id: bucketId,
      product_ref: product.shopify_id,
      generated_title: c.title,
      status: 'candidate',
      approach: c.approach,
      rationale: c.rationale,
    })
    validations.push(validation)
  }

  if (rows.length === 0) throw new Error('The model returned no usable suggestions')

  const { data: inserted, error } = await db()
    .from('bucket_examples')
    .insert(rows)
    .select('id, bucket_id, product_ref, generated_title, status, note, approach, rationale, position, created_at')
  if (error) dbError('bucketExamples', error)

  const candidates: GeneratedCandidate[] = ((inserted ?? []) as BucketExample[]).map((r, i) => ({
    ...r,
    note: r.note ?? '',
    approach: r.approach ?? '',
    rationale: r.rationale ?? '',
    validation: validations[i] ?? { ok: true, issues: [] },
  }))

  // One member consumed this round → it now has rows and drops out of the unused
  // pool. (All candidates share that one product, so don't subtract their count.)
  return { candidates, unusedMembersAfter: Math.max(0, candidateRefs.length - 1) }
}
