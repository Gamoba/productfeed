// AI title optimization for Google Shopping — Claude client + prompts + code
// validation. This module is PURE: it builds prompts, calls Anthropic, and
// validates the result. It does NOT read or write Supabase and does NOT touch
// Shopify — persistence and scoping live in the routes/actions that call it.
//
// Two methods share one title core (see AGENTS-level task spec):
//   - 'auto'        Method A — best-practice structure, no user rules.
//   - 'rule_based'  Method B — Method A + a per-product_type rule block.
//
// Model: claude-haiku-4-5. Titles are a simple, well-specified rewrite at
// 2000+ scale, and the task design requires temperature 0.3 — which is only
// available on temperature-supporting models (removed/400 on Opus 4.8/4.7 and
// Fable 5). Haiku 4.5 is the cheapest tier and is already used for the AI
// mapping in lib/feedGenerator.ts.
//
// Caching: the system prompt (rules + few-shot) is byte-identical across every
// product AND both methods, so it carries a cache_control breakpoint. Volatile
// content — the per-product data AND the Method-B rule block AND the target
// language — all live in the USER turn, after the breakpoint, so one cache
// entry is shared across the whole run regardless of product_type or language.
// (Caching only engages once the system prefix reaches Haiku's 4096-token
// minimum; with enough few-shot examples it will. Verify via
// usage.cache_read_input_tokens.)

import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import type { SupabaseProduct } from '@/lib/sync'

// ── Types ────────────────────────────────────────────────────────────────────

export type TitleMethod = 'auto' | 'rule_based'

// A title_rules row (migration 020), keyed per (feed, product_type). Attribute
// lists hold source-field tokens (e.g. "vendor", "metafield:custom.vintage").
export type TitleRule = {
  product_type: string
  priority_attributes: string[]
  required_attributes: string[]
  excluded_attributes: string[]
}

// The product data fed to the optimizer — a value-only subset of SupabaseProduct.
export type OptimizerProduct = {
  product_ref: string // products.shopify_id (the per-feed product key)
  title: string // original Shopify title — ALWAYS the optimization source
  product_type: string | null
  vendor: string | null
  tags: string[] // split from the comma-separated tags string
  variant_options: string[] // distinct option values across variants
  metafields: { key: string; value: string }[] // "namespace.key" -> value
}

export type OptimizerConfig = {
  charLimit: number // Google Merchant Center max title length (default 150)
  targetLanguage: string // human-readable language name, from the feed's market
  fewShotExamples: string // "perfect" titles (fills the prompt). For a bucket run
  // these are the bucket's APPROVED workshop examples; for the legacy feed run,
  // the feed-level few-shot text.
  // Optional bucket-scoped context — set only on a bucket run (the feed-level run
  // leaves them undefined, so its prompt is unchanged):
  instructions?: string // the bucket's free-text curator instructions
  inputFields?: string[] // prioritised "include if present" field tokens
  // "namespace.key" → human definition name (e.g. "custom._rgang" → "Årgang"), so
  // the wish-list and product payload label metafields legibly instead of by their
  // mangled raw key — exactly as the workshop does. Omitted → raw keys (unchanged).
  metafieldNames?: Map<string, string>
  model?: string // override for testing; defaults to MODEL
  temperature?: number // override; defaults to TEMPERATURE
}

// Raw model output — what the prompt asks Claude to return. source_values are
// the source-language factual values the model says it placed in the title;
// they are what the grounding check verifies against the source data.
export type RawResult = {
  title: string
  source_values: string[]
}

export type ValidationIssue =
  | { code: 'too_long'; detail: string }
  | { code: 'forbidden_term'; detail: string }
  | { code: 'all_caps'; detail: string }
  | { code: 'ungrounded_value'; detail: string }
  | { code: 'ungrounded_measurement'; detail: string }
  | { code: 'empty_title'; detail: string }
  | { code: 'parse_error'; detail: string }

export type ValidationResult = {
  ok: boolean
  issues: ValidationIssue[]
}

// End-to-end result for one product. When `ok` is false the caller must mark
// the product for manual review instead of writing optimized_title.
export type OptimizationOutcome = {
  product_ref: string
  method: TitleMethod
  original_title: string
  proposed_title: string | null // the model's title, regardless of validation (for manual review)
  optimized_title: string | null // accepted-for-feed title; null when validation/parse failed
  source_values: string[] // source-language values the model reported using
  source_hash: string
  validation: ValidationResult
}

// ── Constants ────────────────────────────────────────────────────────────────

// Maps a shop_settings locale code to a human language name for the prompt.
// Falls back to the raw code (Claude handles ISO codes reasonably too).
const LOCALE_LANGUAGES: Record<string, string> = {
  en: 'English', da: 'Danish', de: 'German', fr: 'French', sv: 'Swedish',
  no: 'Norwegian', nb: 'Norwegian', es: 'Spanish', it: 'Italian', nl: 'Dutch',
  fi: 'Finnish', pt: 'Portuguese', pl: 'Polish',
}

export function localeToLanguage(locale: string | null | undefined): string {
  if (!locale) return 'English'
  return LOCALE_LANGUAGES[locale.toLowerCase()] ?? locale
}

const MODEL = 'claude-haiku-4-5'
const TEMPERATURE = 0.3
const MAX_TOKENS = 300 // titles are short; leaves room for the JSON envelope
export const DEFAULT_CHAR_LIMIT = 150 // Google Merchant Center title max

// Promotional / subjective terms that must not appear in a Shopping title.
// Matched case-insensitively as whole words.
const FORBIDDEN_TERMS = [
  'best',
  'sale',
  'cheap',
  'free shipping',
  'discount',
  'offer',
  'deal',
  'bestseller',
  'top',
  'premium quality',
]

// ALL-CAPS pure-letter tokens are banned EXCEPT these acronyms/units. Tokens
// containing digits (e.g. "750ML", "12V") are treated as units and allowed.
const CAPS_ALLOWLIST = new Set([
  'ABV',
  'ML',
  'CL',
  'L',
  'KG',
  'G',
  'MM',
  'CM',
  'USB',
  'LED',
  'UV',
  'SPF',
  'TV',
  'PC',
  'DVD',
  'CD',
  'XL',
  'XXL',
  'XS',
  'S',
  'M',
])

// ── Client factory ───────────────────────────────────────────────────────────

export function createOptimizerClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is missing')
  // maxRetries covers transient 429/5xx; matches the resilience of the Shopify
  // client's manual retry loop without re-implementing it.
  return new Anthropic({ apiKey, maxRetries: 4 })
}

// ── Mapping SupabaseProduct → OptimizerProduct ───────────────────────────────

type StoredVariant = {
  option1: string | null
  option2: string | null
  option3: string | null
}

export function toOptimizerProduct(p: SupabaseProduct): OptimizerProduct {
  const tags = (p.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

  const optionValues = new Set<string>()
  for (const v of (p.variants as StoredVariant[]) ?? []) {
    for (const opt of [v.option1, v.option2, v.option3]) {
      // "Default Title" is Shopify's placeholder for products without real
      // variant options — never a meaningful attribute.
      if (opt && opt !== 'Default Title') optionValues.add(opt.trim())
    }
  }

  const metafields = (p.metafields ?? [])
    .filter((m) => m.value && m.value.trim() !== '')
    .map((m) => ({ key: `${m.namespace}.${m.key}`, value: m.value as string }))

  return {
    product_ref: p.shopify_id,
    title: p.title ?? '',
    product_type: p.product_type,
    vendor: p.vendor,
    tags,
    variant_options: [...optionValues],
    metafields,
  }
}

// ── source_hash (only-changed re-runs) ───────────────────────────────────────

// Stable hash of the exact input that drove an optimization. A later sync that
// leaves these fields unchanged produces the same hash, so the product can be
// skipped. Sorting makes the hash order-independent.
export function sourceHash(product: OptimizerProduct): string {
  const normalized = {
    title: product.title,
    product_type: product.product_type ?? '',
    vendor: product.vendor ?? '',
    tags: [...product.tags].sort(),
    variant_options: [...product.variant_options].sort(),
    metafields: [...product.metafields]
      .map((m) => `${m.key}=${m.value}`)
      .sort(),
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

// ── Prompt building ──────────────────────────────────────────────────────────

// The curator's free-text instruction, rendered as a HARD, prominent rule block.
// Placed near the TOP of the prompt (so it outranks the generic guidance) and
// echoed near the output (recency) by instructionComplianceReminder — so the
// model both reads it first and is reminded of it last. Grounding still wins:
// the framing forbids inventing data to satisfy the instruction. Shared by the
// workshop generation AND the real run so the two prompts keep the same DNA.
export function mandatoryInstructionBlock(instructions: string): string {
  const t = instructions.trim()
  if (!t) return ''
  return `# MANDATORY USER INSTRUCTION — the global rule, always wins
The user gave this instruction for these titles. Treat EVERY part of it as a HARD RULE you MUST obey on EVERY title — not a preference, not a suggestion. It is the GLOBAL rule and OVERRIDES everything below whenever they conflict: the title-structure rules (e.g. "front-load the most important keywords", "Brand → Product type → attributes"), every titling strategy, and the field-priority ranking. Those only arrange the parts the instruction leaves unspecified.
- The instruction defines the ARRANGEMENT, whatever it is. If it pins an element to a POSITION — first, last, or a specific slot — put that element EXACTLY there in every title. If it fixes a relative ORDER of elements, follow that order in every title.
- Field priority is a SEPARATE, lower concept: the ranked field list (if any) only decides which attributes to KEEP when space is tight — it NEVER decides placement. Placement and order are governed solely by this instruction.
The ONE thing that outranks the instruction is grounding, which is absolute: never invent, guess, or translate-in data to satisfy it — apply it only as far as the product's real data allows. If a pinned element is absent for a product, skip it (do NOT invent it) and arrange the rest normally.
"""
${t}
"""`
}

// A short compliance reminder for the output section (recency anchor). Empty
// when there is no instruction, so non-bucket runs are unaffected.
export function instructionComplianceReminder(instructions: string): string {
  return instructions.trim()
    ? `\nBefore you answer, re-check the title against the MANDATORY USER INSTRUCTION above and rewrite it to comply if any part does not — without inventing data.`
    : ''
}

const EMPTY_NAME_MAP = new Map<string, string>()

// Human label for a field token — shared by the workshop AND the run so the model
// sees product data IDENTICALLY in both. A metafield resolves to its definition
// NAME (custom._rgang → "Årgang") via the feed's name map; this is what binds the
// user instruction's wording ("Drue last") to the data. Both the filter-token form
// ("metafield:ns.key", used in the wish-list) and the bare "ns.key" (used as the
// payload metafield key) resolve through the SAME map, so wish-list and payload
// keys match. Standard fields (vendor, product_type, …) are already legible and
// pass through unchanged; an unmapped metafield falls back to its bare "ns.key".
export function fieldDisplayLabel(token: string, nameMap: Map<string, string>): string {
  const isMeta = token.startsWith('metafield:')
  const nsKey = isMeta ? token.slice('metafield:'.length) : token
  const name = nameMap.get(nsKey)
  if (name) return name
  return isMeta ? nsKey : token
}

// De-duplicates labels, keeping the first (highest-priority) occurrence — two
// source tokens can map to the same definition name (e.g. custom.land +
// custom.land_obj → "Land"), and a field should appear only once.
export function dedupeLabels(labels: string[]): string[] {
  return [...new Set(labels)]
}

// The stable, cacheable system prompt. Method A core. The Method-B rule block
// is NOT here — it varies per product_type and would fragment the cache, so it
// goes in the user message. Target language is also in the user message for the
// same reason (so feeds in different languages share one cache entry).
export function buildSystemPrompt(config: OptimizerConfig): string {
  // Per-bucket curator instructions (optional — the feed-level run omits it).
  // Lifted to a prominent HARD block at the top + a compliance reminder at the
  // output, instead of a soft mid-prompt note that the model only half-followed.
  const mandatory = mandatoryInstructionBlock(config.instructions ?? '')
  const mandatoryBlock = mandatory ? `\n\n${mandatory}` : ''
  const reminder = instructionComplianceReminder(config.instructions ?? '')

  // Prioritised "include if present" wish list (optional). Labels are the SAME
  // human names the product payload uses as keys (metafields → definition name),
  // so the model correlates the two and binds the instruction to the data.
  const fields = config.inputFields ?? []
  const fieldLabels = dedupeLabels(fields.map((f) => fieldDisplayLabel(f, config.metafieldNames ?? EMPTY_NAME_MAP)))
  const wishListBlock = fieldLabels.length
    ? `\n\n# Attributes to include — ranked by INCLUSION priority, NOT placement
This list ranks which attributes are most important to KEEP when space is tight (keep the higher-ranked, drop the lower-ranked to stay under the character limit). It does NOT set placement — order and position are governed by the MANDATORY USER INSTRUCTION above (or, when there is no instruction, by the title rules). Each name matches a key in the product data. Include each ONLY if it is present for that product; if it is missing, simply skip it — NEVER invent it:
${fieldLabels.map((f, i) => `${i + 1}. ${f}`).join('\n')}`
    : ''

  // Few-shot examples (optional — omit the whole section when there are none).
  const examplesBlock = config.fewShotExamples.trim()
    ? `\n\n# Examples of good titles\n${config.fewShotExamples.trim()}`
    : ''

  return `You are a product title optimizer for Google Shopping feeds. Rewrite a product's title so it ranks well in Google Shopping search and matches how real shoppers search — while staying 100% truthful to the source data.${mandatoryBlock}

# Title rules
- Structure: Brand → Product type → Key attributes (color, material, size, volume, vintage, model) → Variant. Most searchable terms first.
- Front-load: first ~70 characters carry the most important keywords (titles get truncated). Stay under ${config.charLimit} characters total.
- Language: write the title in the target language given in the user message, using natural phrasing a native speaker would search for — not a literal translation.
- No promotional/subjective language: no "best", "sale", "cheap", "free shipping", "%", "!".
- No ALL-CAPS words (except acronyms/units like ABV, ml, cl).
- No repetition or keyword stuffing.

# Grounding (critical — never violate)
- Use ONLY attributes explicitly present in the provided product data.
- NEVER invent or guess an attribute (vintage, volume, material, region, ABV, etc.). If it is not in the data, leave it out.
- NEVER add a bottle size, volume, or measurement (ml, cl, l, kg, g) unless that exact value is in the data — do not assume a default like 750ml.
- If data is thin, produce a SHORTER but accurate title rather than padding with assumptions.${wishListBlock}${examplesBlock}

# Output — return ONLY valid JSON, no preamble:${reminder}
Also return "source_values": the specific factual values you took from the product data and placed in the title (brand, producer, grape, region, country, vintage, volume, model, etc.), written EXACTLY as they appear in the product data — in the source language, NOT translated. Do not list the generic product type or any word you translated or inferred.
{ "title": "...", "source_values": ["Marqués de Murrieta", "1995", "Rioja"] }`
}

// The Method-B rule block, injected into the user message when a rule exists
// for this product's type.
function buildRuleBlock(rule: TitleRule): string {
  const fmt = (arr: string[]) => (arr.length ? arr.join(', ') : '(none)')
  return `# Priority rules for this product type: ${rule.product_type}
Order attributes in the title by this priority, most important first:
${fmt(rule.priority_attributes)}
Always include if present: ${fmt(rule.required_attributes)}
Never include: ${fmt(rule.excluded_attributes)}
If a priority attribute is missing from the data, skip it (do NOT invent it) and move on.`
}

// The user message: target language, optional rule block, and value-only
// product data. Only fields with a value are sent.
export function buildUserMessage(
  product: OptimizerProduct,
  targetLanguage: string,
  rule?: TitleRule,
  metafieldNames?: Map<string, string>
): string {
  const data: Record<string, unknown> = { current_title: product.title }
  if (product.product_type) data.product_type = product.product_type
  if (product.vendor) data.vendor = product.vendor
  if (product.tags.length) data.tags = product.tags
  if (product.variant_options.length) data.variant_options = product.variant_options
  if (product.metafields.length) {
    // Key metafields by their human definition name (custom._rgang → "Årgang") so
    // the model sees them EXACTLY as the workshop does and the instruction binds to
    // the data. Falls back to the raw "ns.key" when no name is known.
    const nm = metafieldNames ?? EMPTY_NAME_MAP
    data.metafields = Object.fromEntries(product.metafields.map((m) => [nm.get(m.key) ?? m.key, m.value]))
  }

  const ruleBlock = rule ? `${buildRuleBlock(rule)}\n\n` : ''
  return `${ruleBlock}Optimize the title for this product. Target language: ${targetLanguage}.
Product data: ${JSON.stringify(data)}`
}

// ── Anthropic call ───────────────────────────────────────────────────────────

// Tolerant JSON extraction: strips ``` fences and pulls the first {...} block,
// so an occasional preamble doesn't fail the whole product. (Hardening path:
// switch to output_config.format with a json_schema — Haiku 4.5 supports it —
// for guaranteed-valid JSON.)
function parseRawResult(text: string): RawResult | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1))
    if (typeof obj.title !== 'string') return null
    const values = Array.isArray(obj.source_values)
      ? obj.source_values.filter((a: unknown): a is string => typeof a === 'string')
      : []
    return { title: obj.title.trim(), source_values: values }
  } catch {
    return null
  }
}

// One model call for one product. Returns the parsed result, or null on a
// parse failure (caller marks for manual review).
export async function callOptimizer(
  client: Anthropic,
  systemPrompt: string,
  product: OptimizerProduct,
  targetLanguage: string,
  config: OptimizerConfig,
  rule?: TitleRule
): Promise<RawResult | null> {
  const msg = await client.messages.create({
    model: config.model ?? MODEL,
    max_tokens: MAX_TOKENS,
    temperature: config.temperature ?? TEMPERATURE,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserMessage(product, targetLanguage, rule, config.metafieldNames) }],
  })
  const block = msg.content[0]
  if (!block || block.type !== 'text') return null
  return parseRawResult(block.text)
}

// ── Code validation (second layer against hallucination) ─────────────────────

// Normalizes an attribute/field token for grounding comparison.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Builds one normalized "haystack" of all source-data values (spaces and
// punctuation stripped), so a claimed value can be matched as a substring.
function sourceHaystack(product: OptimizerProduct): string {
  return norm(
    [
      product.title,
      product.product_type ?? '',
      product.vendor ?? '',
      product.tags.join(' '),
      product.variant_options.join(' '),
      product.metafields.map((m) => `${m.key} ${m.value}`).join(' '),
    ].join(' ')
  )
}

// A claimed source value is grounded if its normalized form is a substring of
// the source haystack, or every significant word-token of it is. norm() strips
// spaces/accents on both sides, so multi-word and accented values match
// consistently (e.g. "Cabernet Franc", "Châteauneuf-du-Pape").
function valueGrounded(value: string, haystack: string): boolean {
  const whole = norm(value)
  if (whole.length === 0) return true // punctuation-only — nothing to ground
  if (whole.length >= 3 && haystack.includes(whole)) return true
  const tokens = value
    .split(/[\s,/|]+/)
    .map(norm)
    .filter((t) => t.length >= 2)
  if (tokens.length === 0) return whole.length < 3 // very short value, can't meaningfully check
  return tokens.every((t) => haystack.includes(t))
}

export function validateResult(
  raw: RawResult,
  product: OptimizerProduct,
  config: OptimizerConfig
): ValidationResult {
  const issues: ValidationIssue[] = []
  const title = raw.title.trim()

  if (!title) {
    issues.push({ code: 'empty_title', detail: 'Model returned an empty title' })
    return { ok: false, issues }
  }

  // 1. Character count
  if (title.length > config.charLimit) {
    issues.push({
      code: 'too_long',
      detail: `${title.length} > ${config.charLimit} chars`,
    })
  }

  // 2. Forbidden terms / characters
  const lower = title.toLowerCase()
  for (const term of FORBIDDEN_TERMS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(lower)) {
      issues.push({ code: 'forbidden_term', detail: `contains "${term}"` })
    }
  }
  if (title.includes('!')) issues.push({ code: 'forbidden_term', detail: 'contains "!"' })
  if (title.includes('%')) issues.push({ code: 'forbidden_term', detail: 'contains "%"' })

  // 3. ALL-CAPS pure-letter words (units/acronyms allowlisted; tokens with
  //    digits treated as units and skipped).
  for (const word of title.split(/\s+/)) {
    const stripped = word.replace(/[^A-Za-z0-9]/g, '')
    if (stripped.length < 2) continue
    if (/\d/.test(stripped)) continue
    if (stripped === stripped.toUpperCase() && /[A-Z]/.test(stripped)) {
      if (!CAPS_ALLOWLIST.has(stripped.toUpperCase())) {
        issues.push({ code: 'all_caps', detail: `ALL-CAPS word "${word}"` })
      }
    }
  }

  // 4. Grounding — every value the model says it used must be findable in the
  //    source data. This is a self-reported check: it catches values the model
  //    *declares* that aren't in the data (e.g. an invented "750ml"). It cannot
  //    catch a hallucinated value the model omits from source_values — the
  //    prompt instructs the model to list every factual value it placed.
  const haystack = sourceHaystack(product)
  for (const value of raw.source_values) {
    if (!valueGrounded(value, haystack)) {
      issues.push({
        code: 'ungrounded_value',
        detail: `value "${value}" not found in source data`,
      })
    }
  }

  // 5. Measurement guard — closes the self-report gap for the most common
  //    injected default (e.g. "750ml"). Any volume/measurement token IN THE
  //    TITLE must trace to the source data, whether or not the model declared
  //    it in source_values.
  for (const m of title.matchAll(/\b\d+(?:[.,]\d+)?\s?(?:ml|cl|l|kg|g)\b/gi)) {
    if (!haystack.includes(norm(m[0]))) {
      issues.push({
        code: 'ungrounded_measurement',
        detail: `measurement "${m[0].trim()}" not found in source data`,
      })
    }
  }

  return { ok: issues.length === 0, issues }
}

// ── Single-product orchestration ─────────────────────────────────────────────

export async function optimizeOne(
  client: Anthropic,
  systemPrompt: string,
  product: OptimizerProduct,
  method: TitleMethod,
  config: OptimizerConfig,
  rule?: TitleRule
): Promise<OptimizationOutcome> {
  const hash = sourceHash(product)
  const base: Omit<
    OptimizationOutcome,
    'proposed_title' | 'optimized_title' | 'source_values' | 'validation'
  > = {
    product_ref: product.product_ref,
    method,
    original_title: product.title,
    source_hash: hash,
  }

  let raw: RawResult | null
  try {
    raw = await callOptimizer(client, systemPrompt, product, config.targetLanguage, config, rule)
  } catch (err) {
    return {
      ...base,
      proposed_title: null,
      optimized_title: null,
      source_values: [],
      validation: { ok: false, issues: [{ code: 'parse_error', detail: String(err) }] },
    }
  }

  if (!raw) {
    return {
      ...base,
      proposed_title: null,
      optimized_title: null,
      source_values: [],
      validation: { ok: false, issues: [{ code: 'parse_error', detail: 'Could not parse JSON' }] },
    }
  }

  const validation = validateResult(raw, product, config)
  return {
    ...base,
    proposed_title: raw.title,
    optimized_title: validation.ok ? raw.title : null,
    source_values: raw.source_values,
    validation,
  }
}

// ── Batch with bounded concurrency ───────────────────────────────────────────

// Mirrors the Shopify client's discipline: process in parallel but bounded.
// The SDK's maxRetries handles 429/5xx back-off per request, so this only
// needs to cap concurrency. For a full "optimize everything" run over 2000+
// products, prefer the Message Batches API (50% cost, async) — this path is
// for interactive/small scopes and the step-2 test.
export async function optimizeBatch(
  client: Anthropic,
  products: OptimizerProduct[],
  method: TitleMethod,
  config: OptimizerConfig,
  rulesByType: Map<string, TitleRule> = new Map(),
  concurrency = 5
): Promise<OptimizationOutcome[]> {
  const systemPrompt = buildSystemPrompt(config)
  const out: OptimizationOutcome[] = new Array(products.length)
  let next = 0

  async function worker() {
    while (true) {
      const i = next++
      if (i >= products.length) return
      const product = products[i]
      const rule =
        method === 'rule_based' && product.product_type
          ? rulesByType.get(product.product_type)
          : undefined
      out[i] = await optimizeOne(client, systemPrompt, product, method, config, rule)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, products.length) }, worker))
  return out
}
