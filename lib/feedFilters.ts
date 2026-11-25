// Shared product-field resolution + filter logic.
//
// Extracted from lib/feedGenerator.ts so the SAME include/exclude filter
// mechanic can be reused for the AI title-optimization scope (a separate filter
// set — see title_optimization_filters) without duplicating the evaluation
// rules. feedGenerator.ts imports resolveField + applyFeedFilters from here;
// the optimization scope uses applyFeedFilters against its own filter rows.
//
// resolveField lives here because it's the low-level "read a product field by
// token" primitive that both filters and feed mappings depend on — it has no
// feed/mapping/AI dependencies.

import type { SupabaseProduct } from '@/lib/sync'

// ── Types ────────────────────────────────────────────────────────────────────

// caseSensitive controls text matching for this rule. Undefined = case-sensitive
// (the original behaviour, so legacy saved rules are unchanged); new rules created
// in the editor set it explicitly. Ignored for numeric (>, <) and is_(not_)empty.
export type FeedFilterRule = { field: string; operator: string; value: string; caseSensitive?: boolean }

export type FeedFilter = {
  filter_type: 'include' | 'exclude'
  operator: 'AND' | 'OR'
  rules: FeedFilterRule[]
}

// ── Field resolution ─────────────────────────────────────────────────────────

// Builds a product URL using the selected market's rootUrl when available.
// `marketUrl` may be a subdomain (https://shop.fr) or a subfolder (https://shop.com/fr) —
// in both cases we strip a trailing slash and append /products/<handle>.
//
// There is deliberately NO env fallback here. SHOP_DOMAIN used to fill in when
// marketUrl was null, which meant a project whose market has no web presence
// emitted links to whatever single store that env var named — the wrong shop
// entirely. Callers resolve the base URL per feed (market URL, else the
// project's own primary_domain) and pass it in; no base means no link.
function buildProductUrl(handle: string | null | undefined, marketUrl: string | null): string {
  if (!handle || !marketUrl) return ''
  return `${marketUrl.replace(/\/+$/, '')}/products/${handle}`
}

export function resolveField(
  field: string,
  product: SupabaseProduct,
  marketUrl: string | null
): string {
  if (!field) return ''

  if (field === 'url') {
    // Feed-URL sources carry the product's real URL; their URL scheme isn't
    // Shopify's /products/<handle>, so it's used verbatim.
    if (product.link) return product.link
    return buildProductUrl(product.handle, marketUrl)
  }

  // AI-optimized title source. The optimized title is attached onto the product
  // (as `optimized_title`) by the feed generator when any mapping uses this
  // token. Products without an optimized title fall back to the raw Shopify
  // title, so a half-optimized catalog still produces a valid feed.
  if (field === 'ai_optimized_title') {
    const opt = (product as Record<string, unknown>).optimized_title
    if (typeof opt === 'string' && opt.trim() !== '') return opt
    return product.title ?? ''
  }

  // The bare "id" source field = the item id the generator would auto-inject
  // (shopify_id in product mode, shopify_id_variantId in variant mode). The
  // generator attaches it as `feed_item_id` before resolving mappings, so a
  // mapping like Combine("shopify_ZZ_" + id) or the default FIELD "id" reads
  // the same value the preview in MappingClient shows. Without it (filters,
  // bucket examples) the legacy fall-through below is kept unchanged.
  if (field === 'id') {
    const fid = (product as Record<string, unknown>).feed_item_id
    if (typeof fid === 'string' && fid !== '') return fid
  }

  // item_group_id is the source-field name shown in the dropdown for the
  // product's Shopify ID. shopify_id is kept as a back-compat alias for
  // mappings saved before the rename.
  if (field === 'item_group_id' || field === 'shopify_id') {
    return product.shopify_id ? String(product.shopify_id) : ''
  }

  if (field.startsWith('metafield:')) {
    const rest = field.slice('metafield:'.length)
    const dot = rest.indexOf('.')
    if (dot === -1) return ''
    const namespace = rest.slice(0, dot)
    const key = rest.slice(dot + 1)
    return product.metafields.find((m) => m.namespace === namespace && m.key === key)?.value ?? ''
  }

  const variantMatch = field.match(/^variants\[(\d+)\]\.(.+)$/)
  if (variantMatch) {
    const variants = product.variants as Record<string, unknown>[]
    return String(variants?.[+variantMatch[1]]?.[variantMatch[2]] ?? '')
  }

  const imageMatch = field.match(/^images\[(\d+)\]\.(.+)$/)
  if (imageMatch) {
    const images = product.images as Record<string, unknown>[]
    return String(images?.[+imageMatch[1]]?.[imageMatch[2]] ?? '')
  }

  const val = (product as Record<string, unknown>)[field]
  if (val === null || val === undefined) return ''
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

// ── Filter evaluation ────────────────────────────────────────────────────────

function evalFilterRule(
  rule: FeedFilterRule,
  product: SupabaseProduct,
  marketUrl: string | null
): boolean {
  // Case folding for text comparisons. Undefined caseSensitive = case-sensitive
  // (unchanged legacy behaviour). Emptiness and numeric checks use the raw value.
  const sensitive = rule.caseSensitive ?? true
  const fold = (s: string) => (sensitive ? s : s.toLowerCase())
  const rv = fold(rule.value)

  if (rule.field === 'collections') {
    const cols = ((product.collections as string[] | null | undefined) ?? []).map(fold)
    switch (rule.operator) {
      case 'contains':
      case 'equals': return cols.includes(rv)
      case 'does_not_contain':
      case 'not_equals': return !cols.includes(rv)
      case 'is_empty': return cols.length === 0
      case 'is_not_empty': return cols.length > 0
      default: return true
    }
  }
  const raw = resolveField(rule.field, product, marketUrl)
  const v = fold(raw)
  switch (rule.operator) {
    case 'contains': return v.includes(rv)
    case 'does_not_contain': return !v.includes(rv)
    case 'equals': return v === rv
    case 'not_equals': return v !== rv
    case 'starts_with': return v.startsWith(rv)
    case 'ends_with': return v.endsWith(rv)
    case 'is_empty': return !raw
    case 'is_not_empty': return !!raw
    case 'greater_than': return parseFloat(raw) > parseFloat(rule.value)
    case 'less_than': return parseFloat(raw) < parseFloat(rule.value)
    default: return true
  }
}

const NO_VALUE_OPS = new Set(['is_empty', 'is_not_empty'])

function matchesFilter(
  product: SupabaseProduct,
  filter: FeedFilter,
  marketUrl: string | null
): boolean {
  const { operator } = filter
  const activeRules = filter.rules.filter((r) => NO_VALUE_OPS.has(r.operator) || r.value !== '')
  if (!activeRules.length) return true
  let result = evalFilterRule(activeRules[0], product, marketUrl)
  for (let i = 1; i < activeRules.length; i++) {
    const val = evalFilterRule(activeRules[i], product, marketUrl)
    result = operator === 'OR' ? result || val : result && val
  }
  return result
}

// Applies an include filter then an exclude filter (the standard feed scope).
// Reused verbatim by both feed generation and the title-optimization scope.
// Which of the feed's two rule sets actually filter anything. Shared by
// applyFeedFilters and the fast count (countFilteredProducts) so they can't
// disagree about when "no rules" means "every active product".
export function activeFilterSides(filters: FeedFilter[]): { include: FeedFilter | null; exclude: FeedFilter | null } {
  const includeFilter = filters.find((f) => f.filter_type === 'include')
  const excludeFilter = filters.find((f) => f.filter_type === 'exclude')
  return {
    include: includeFilter && includeFilter.rules.length > 0 ? includeFilter : null,
    exclude:
      excludeFilter && excludeFilter.rules.some((r) => NO_VALUE_OPS.has(r.operator) || r.value !== '')
        ? excludeFilter
        : null,
  }
}

export function applyFeedFilters(
  products: SupabaseProduct[],
  filters: FeedFilter[],
  marketUrl: string | null
): SupabaseProduct[] {
  const { include, exclude } = activeFilterSides(filters)
  let result = products
  if (include) result = result.filter((p) => matchesFilter(p, include, marketUrl))
  if (exclude) result = result.filter((p) => !matchesFilter(p, exclude, marketUrl))
  return result
}

// ── Why a product is in or out of the feed ──────────────────────────────────

const OP_LABEL: Record<string, string> = {
  contains: 'indeholder',
  does_not_contain: 'indeholder ikke',
  equals: 'er',
  not_equals: 'er ikke',
  starts_with: 'starter med',
  ends_with: 'slutter med',
  is_empty: 'er tom',
  is_not_empty: 'er ikke tom',
  greater_than: 'er over',
  less_than: 'er under',
}

// Readable names for the fields the rule editor offers; anything else (a
// metafield, a custom token) is shown as its key.
const FIELD_LABEL: Record<string, string> = {
  title: 'titel',
  vendor: 'producent',
  product_type: 'varetype',
  tags: 'tags',
  status: 'status',
  handle: 'handle',
  collections: 'kollektioner',
  'variants[0].price': 'pris',
  'variants[0].sku': 'SKU',
  'variants[0].inventory_quantity': 'lager',
  'variants[0].barcode': 'stregkode',
}

function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.replace(/^metafield:/, '')
}

export function describeRule(rule: FeedFilterRule): string {
  const op = OP_LABEL[rule.operator] ?? rule.operator
  const field = fieldLabel(rule.field)
  return NO_VALUE_OPS.has(rule.operator) ? `${field} ${op}` : `${field} ${op} ${rule.value}`
}

export type ScopeExplanation = { inFeed: true } | { inFeed: false; reason: string }

// Whether one product makes it into the feed, and if not, why — in the same
// order the generator decides it: only active products, then the include
// filter, then the exclude filter. Mirrors applyFeedFilters exactly; used by
// the Products page to label rows without generating the feed.
export function explainScope(
  product: SupabaseProduct,
  filters: FeedFilter[],
  marketUrl: string | null
): ScopeExplanation {
  if (product.status !== 'active') return { inFeed: false, reason: 'Ikke aktiv i shoppen' }

  const includeFilter = filters.find((f) => f.filter_type === 'include')
  if (includeFilter && includeFilter.rules.length > 0 && !matchesFilter(product, includeFilter, marketUrl)) {
    return { inFeed: false, reason: 'Uden for reglerne for inkludering' }
  }

  const excludeFilter = filters.find((f) => f.filter_type === 'exclude')
  if (excludeFilter && matchesExclude(product, excludeFilter, marketUrl)) {
    const active = excludeFilter.rules.filter((r) => NO_VALUE_OPS.has(r.operator) || r.value !== '')
    // OR: name the first rule that matched. AND: every rule matched together,
    // so name them all.
    if (excludeFilter.operator === 'OR') {
      const hit = active.find((r) => evalFilterRule(r, product, marketUrl))
      if (hit) return { inFeed: false, reason: `Regel: ${describeRule(hit)}` }
    }
    return {
      inFeed: false,
      reason: `${active.length === 1 ? 'Regel' : 'Regler'}: ${active.map(describeRule).join(' og ')}`,
    }
  }
  return { inFeed: true }
}

function matchesExclude(product: SupabaseProduct, filter: FeedFilter, marketUrl: string | null): boolean {
  if (!filter.rules.some((r) => NO_VALUE_OPS.has(r.operator) || r.value !== '')) return false
  return matchesFilter(product, filter, marketUrl)
}

// One rule against one product, exactly as the filters evaluate it. For
// per-rule counts on the Inkludér / ekskludér page.
export function ruleMatches(rule: FeedFilterRule, product: SupabaseProduct, marketUrl: string | null): boolean {
  return evalFilterRule(rule, product, marketUrl)
}

// A rule counts when it has a value, or its operator needs none.
export function isActiveRule(rule: FeedFilterRule): boolean {
  return NO_VALUE_OPS.has(rule.operator) || rule.value !== ''
}
