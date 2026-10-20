export type IdPattern = 'shopify_channel' | 'own_product' | 'own_variant'

export type ParsedItemId = {
  productRef: string
  variantRef: string | null
  country: string | null
}

const RE_SHOPIFY_CHANNEL = /^shopify_([a-z]{2})_(\d+)_(\d+)$/
const RE_OWN_VARIANT = /^(\d+)_(\d+)$/
const RE_OWN_PRODUCT = /^(\d+)$/

export function parseItemId(itemId: string, pattern: IdPattern): ParsedItemId | null {
  const id = itemId.trim().toLowerCase()
  if (!id) return null

  switch (pattern) {
    case 'shopify_channel': {
      const m = RE_SHOPIFY_CHANNEL.exec(id)
      return m ? { productRef: m[2], variantRef: m[3], country: m[1] } : null
    }
    case 'own_variant': {
      const m = RE_OWN_VARIANT.exec(id)
      return m ? { productRef: m[1], variantRef: m[2], country: null } : null
    }
    case 'own_product': {
      const m = RE_OWN_PRODUCT.exec(id)
      return m ? { productRef: m[1], variantRef: null, country: null } : null
    }
  }
}

export function buildItemId(
  pattern: IdPattern,
  productRef: string,
  variantRef?: string | null,
  country?: string | null
): string | null {
  if (!productRef) return null
  switch (pattern) {
    case 'shopify_channel':
      if (!variantRef || !country) return null
      return `shopify_${country.toLowerCase()}_${productRef}_${variantRef}`
    case 'own_variant':
      if (!variantRef) return null
      return `${productRef}_${variantRef}`
    case 'own_product':
      return String(productRef)
  }
}

export type PatternDetection = {
  pattern: IdPattern | null
  confidence: number
  country: string | null
  counts: Record<IdPattern, number>
  unmatched: number
}

export function detectIdPattern(itemIds: string[]): PatternDetection {
  const counts: Record<IdPattern, number> = {
    shopify_channel: 0,
    own_variant: 0,
    own_product: 0,
  }
  const countries = new Map<string, number>()
  let unmatched = 0

  for (const raw of itemIds) {
    const id = raw.trim().toLowerCase()
    const ch = RE_SHOPIFY_CHANNEL.exec(id)
    if (ch) {
      counts.shopify_channel++
      countries.set(ch[1], (countries.get(ch[1]) ?? 0) + 1)
      continue
    }
    if (RE_OWN_VARIANT.test(id)) {
      counts.own_variant++
      continue
    }
    if (RE_OWN_PRODUCT.test(id)) {
      counts.own_product++
      continue
    }
    unmatched++
  }

  const total = itemIds.length
  const [winner, top] = (Object.entries(counts) as [IdPattern, number][]).sort(
    (a, b) => b[1] - a[1]
  )[0] ?? ['own_product', 0]

  if (!total || top === 0) {
    return { pattern: null, confidence: 0, country: null, counts, unmatched }
  }

  const country =
    winner === 'shopify_channel'
      ? ([...countries].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null)
      : null

  return { pattern: winner, confidence: top / total, country, counts, unmatched }
}

export function resolvePattern(
  configured: string | null | undefined,
  sample: string[]
): PatternDetection {
  if (configured && configured !== 'auto') {
    const pattern = configured as IdPattern
    const detected = detectIdPattern(sample)
    return { ...detected, pattern, confidence: detected.counts[pattern] / (sample.length || 1) }
  }
  return detectIdPattern(sample)
}
