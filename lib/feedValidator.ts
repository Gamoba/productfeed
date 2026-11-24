import { createClient } from '@supabase/supabase-js'
import { generatePreview, type FeedInput, type PreviewRow } from '@/lib/feedGenerator'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── Types ──────────────────────────────────────────────────────────────────

export type ValidationIssue = {
  field: string
  type: 'error' | 'warning'
  message: string
  affectedCount: number
  exampleValue?: string
}

export type ValidationResult = {
  status: 'ok' | 'warnings' | 'errors'
  issues: ValidationIssue[]
  productsChecked: number
}

// ── Constants ──────────────────────────────────────────────────────────────

// Exported for the Overview page, which counts how many of these are unmapped.
export const REQUIRED_GOOGLE_FIELDS = [
  'id', 'title', 'description', 'link', 'image_link', 'availability', 'price', 'brand',
]

const VALID_AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'preorder', 'backorder'])

// "199.00 DKK", "114.0 EUR", "50 USD" — digits, optional 1-2 decimals, space, ISO code.
const PRICE_OK_REGEX = /^\d+(\.\d{1,2})?\s+[A-Z]{3}$/
// Numeric-only price ("199", "199.00") — dot decimals, no currency code.
const PRICE_NO_CURRENCY_REGEX = /^\d+(\.\d{1,2})?$/
// Number directly followed by ISO code with no separating space ("199.00EUR").
const PRICE_MISSING_SPACE_REGEX = /^\d+(\.\d{1,2})?[A-Z]{3}$/

const HTTPS_REGEX = /^https:\/\//
const ALL_DIGITS_REGEX = /^\d+$/

const EXAMPLE_TRUNCATE = 80

// ── Helpers ────────────────────────────────────────────────────────────────

function truncate(s: string): string {
  return s.length > EXAMPLE_TRUNCATE ? s.slice(0, EXAMPLE_TRUNCATE) + '…' : s
}

function isBlank(v: string): boolean {
  return v.trim() === ''
}

// Walks the preview rows for a single field, skipping AI placeholders, and
// returns the count + first failing value for any rows the predicate matches.
function collectFailing(
  rows: PreviewRow[],
  field: string,
  predicate: (value: string) => boolean
): { count: number; example?: string } {
  let count = 0
  let example: string | undefined
  for (const row of rows) {
    const raw = row.fields[field] ?? ''
    if (raw === '__AI__') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (predicate(trimmed)) {
      count++
      if (example === undefined) example = raw
    }
  }
  return { count, example }
}

// ── Main export ────────────────────────────────────────────────────────────

// `input.products`: the feed's products, when the caller already loaded them
// for generateFeed (see loadFeedProducts) — saves a second full catalogue read.
export async function validateFeed(feedId: string, input: FeedInput = {}): Promise<ValidationResult> {
  const db = adminClient()

  const { data: mappingsData } = await db
    .from('feed_mappings')
    .select('google_field, mapping_type')
    .eq('feed_id', feedId)

  const mappedFields = new Set(
    (mappingsData ?? [])
      .filter((m) => m.mapping_type && m.mapping_type !== '')
      .map((m) => m.google_field as string)
  )

  const issues: ValidationIssue[] = []

  // 1. Required-field mapping presence ─────────────────────────────────────
  for (const field of REQUIRED_GOOGLE_FIELDS) {
    if (!mappedFields.has(field)) {
      issues.push({
        field,
        type: 'error',
        message: 'Required field is not mapped',
        affectedCount: 0,
      })
    }
  }

  const preview = await generatePreview(feedId, 20, input)
  const rows = preview.rows

  // 2. Empty-rate checks for required fields ──────────────────────────────
  // For each required, mapped field, count how many sample rows produce a
  // blank value. >50% blank is an error; 1-50% is a warning. id is stricter:
  // any blank id is an error (Google rejects feeds with blank IDs outright).
  for (const field of REQUIRED_GOOGLE_FIELDS) {
    if (!mappedFields.has(field)) continue

    const checkable = rows.filter((r) => (r.fields[field] ?? '') !== '__AI__')
    const total = checkable.length
    if (total === 0) continue

    const blanks = checkable.filter((r) => isBlank(r.fields[field] ?? ''))
    if (blanks.length === 0) continue

    if (field === 'id') {
      issues.push({
        field,
        type: 'error',
        message: `ID is empty or blank on ${blanks.length} of ${total} products`,
        affectedCount: blanks.length,
      })
      continue
    }

    const pct = (blanks.length / total) * 100
    if (pct > 50) {
      issues.push({
        field,
        type: 'error',
        message: `Empty value on ${blanks.length} of ${total} products (${Math.round(pct)}%) — above the 50% threshold`,
        affectedCount: blanks.length,
      })
    } else {
      issues.push({
        field,
        type: 'warning',
        message: `Empty value on ${blanks.length} of ${total} products`,
        affectedCount: blanks.length,
      })
    }
  }

  // 3. Format checks (only on non-blank values) ───────────────────────────

  // price — classify each value into the most specific bucket. Comma decimals
  // and missing currency are errors; "missing space" between number and code
  // is a warning since the value is fixable but recognisable.
  if (mappedFields.has('price')) {
    type PriceProblem = 'comma' | 'noCurrency' | 'missingSpace' | 'wrongFormat'
    const buckets: Record<PriceProblem, { count: number; example?: string }> = {
      comma: { count: 0 },
      noCurrency: { count: 0 },
      missingSpace: { count: 0 },
      wrongFormat: { count: 0 },
    }

    for (const row of rows) {
      const raw = row.fields['price'] ?? ''
      if (raw === '__AI__') continue
      const trimmed = raw.trim()
      if (!trimmed) continue
      if (PRICE_OK_REGEX.test(trimmed)) continue

      let kind: PriceProblem
      if (trimmed.includes(',')) kind = 'comma'
      else if (PRICE_NO_CURRENCY_REGEX.test(trimmed)) kind = 'noCurrency'
      else if (PRICE_MISSING_SPACE_REGEX.test(trimmed)) kind = 'missingSpace'
      else kind = 'wrongFormat'

      buckets[kind].count++
      if (buckets[kind].example === undefined) buckets[kind].example = raw
    }

    if (buckets.comma.count > 0) {
      issues.push({
        field: 'price',
        type: 'error',
        message: 'Price uses comma as decimal separator — Google requires a period (e.g. "199.00 EUR")',
        affectedCount: buckets.comma.count,
        exampleValue: buckets.comma.example,
      })
    }
    if (buckets.noCurrency.count > 0) {
      issues.push({
        field: 'price',
        type: 'error',
        message: 'Price is missing the ISO currency code after the number (e.g. " USD" or " EUR")',
        affectedCount: buckets.noCurrency.count,
        exampleValue: buckets.noCurrency.example,
      })
    }
    if (buckets.missingSpace.count > 0) {
      issues.push({
        field: 'price',
        type: 'warning',
        message: 'Price is missing a space between the number and the currency code (e.g. "199.00 EUR" instead of "199.00EUR")',
        affectedCount: buckets.missingSpace.count,
        exampleValue: buckets.missingSpace.example,
      })
    }
    if (buckets.wrongFormat.count > 0) {
      issues.push({
        field: 'price',
        type: 'error',
        message: 'Invalid price format — must be number + space + ISO currency code (e.g. "199.00 EUR")',
        affectedCount: buckets.wrongFormat.count,
        exampleValue: buckets.wrongFormat.example,
      })
    }
  }

  // availability
  if (mappedFields.has('availability')) {
    const bad = collectFailing(rows, 'availability', (v) => !VALID_AVAILABILITY.has(v))
    if (bad.count > 0) {
      issues.push({
        field: 'availability',
        type: 'error',
        message: 'Invalid availability — must be exactly: in_stock, out_of_stock, preorder or backorder',
        affectedCount: bad.count,
        exampleValue: bad.example,
      })
    }
  }

  // link
  if (mappedFields.has('link')) {
    const bad = collectFailing(rows, 'link', (v) => !HTTPS_REGEX.test(v))
    if (bad.count > 0) {
      issues.push({
        field: 'link',
        type: 'error',
        message: 'Link must start with "https://"',
        affectedCount: bad.count,
        exampleValue: bad.example,
      })
    }
  }

  // image_link
  if (mappedFields.has('image_link')) {
    const bad = collectFailing(rows, 'image_link', (v) => !HTTPS_REGEX.test(v))
    if (bad.count > 0) {
      issues.push({
        field: 'image_link',
        type: 'error',
        message: 'Image link must start with "https://"',
        affectedCount: bad.count,
        exampleValue: bad.example,
      })
    }
  }

  // title length
  if (mappedFields.has('title')) {
    const bad = collectFailing(rows, 'title', (v) => v.length > 150)
    if (bad.count > 0) {
      issues.push({
        field: 'title',
        type: 'warning',
        message: 'Title is too long — Google recommends max 150 characters',
        affectedCount: bad.count,
        exampleValue: bad.example ? truncate(bad.example) : undefined,
      })
    }
  }

  // description length
  if (mappedFields.has('description')) {
    const tooLong = collectFailing(rows, 'description', (v) => v.length > 5000)
    if (tooLong.count > 0) {
      issues.push({
        field: 'description',
        type: 'warning',
        message: 'Description is too long — Google recommends max 5000 characters',
        affectedCount: tooLong.count,
      })
    }
  }

  // gtin (optional field — only checked when mapped)
  if (mappedFields.has('gtin')) {
    const bad = collectFailing(rows, 'gtin', (v) => !ALL_DIGITS_REGEX.test(v))
    if (bad.count > 0) {
      issues.push({
        field: 'gtin',
        type: 'warning',
        message: 'GTIN contains non-numeric characters',
        affectedCount: bad.count,
        exampleValue: bad.example,
      })
    }
  }

  const hasErrors = issues.some((i) => i.type === 'error')
  const hasWarnings = issues.some((i) => i.type === 'warning')

  return {
    status: hasErrors ? 'errors' : hasWarnings ? 'warnings' : 'ok',
    issues,
    productsChecked: rows.length,
  }
}
