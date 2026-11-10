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
export function applyFeedFilters(
  products: SupabaseProduct[],
  filters: FeedFilter[],
  marketUrl: string | null
): SupabaseProduct[] {
  const includeFilter = filters.find((f) => f.filter_type === 'include')
  const excludeFilter = filters.find((f) => f.filter_type === 'exclude')
  let result = products
  if (includeFilter && includeFilter.rules.length > 0) {
    result = result.filter((p) => matchesFilter(p, includeFilter, marketUrl))
  }
  if (excludeFilter && excludeFilter.rules.some((r) => NO_VALUE_OPS.has(r.operator) || r.value !== '')) {
    result = result.filter((p) => !matchesFilter(p, excludeFilter, marketUrl))
  }
  return result
}
