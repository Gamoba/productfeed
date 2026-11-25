import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseProduct } from '@/lib/sync'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { enforceRateLimit } from '@/lib/rateLimit'
import { errorResponse } from '@/lib/errors'

function adminClient() {
  return adminDb()
}


// ── Types ──────────────────────────────────────────────────────────────────

type ExistingMapping = {
  google_field: string
  mapping_type: string
  config: Record<string, unknown>
}

// ── Shopify field list ─────────────────────────────────────────────────────

const SHOPIFY_STANDARD_FIELDS = [
  'item_group_id — Shopify product ID, used as the shared group ID for variants of the same product',
  'title — product name',
  'body_html — product description with HTML (use STRIP_HTML mapping to remove HTML)',
  'vendor — vendor/brand name',
  'handle — URL slug',
  'url — full product URL including domain (https://...)',
  'tags — comma-separated tags',
  'status — active/draft/archived',
  'product_type — product category from Shopify',
  'published_at / created_at / updated_at — dates',
  'collections — array of collection names',
  'variants[0].id — variant ID (use in variant feed mode)',
  'variants[0].title — variant title',
  'variants[0].price — price as decimal string without currency, e.g. "199.00"',
  'variants[0].compare_at_price — compare-at price without currency',
  'variants[0].sku — stock keeping unit',
  'variants[0].barcode — EAN/GTIN/UPC barcode',
  'variants[0].weight — weight in grams',
  'variants[0].inventory_quantity — inventory quantity (integer)',
  'variants[0].option1 / option2 / option3 — variant options',
  'images[0].src — URL to the first product image',
  'images[1].src — URL to the second product image',
]

// ── Helpers ────────────────────────────────────────────────────────────────

function formatMappedFieldsList(mappings: ExistingMapping[]): string {
  if (!mappings.length) return '  (none — all fields are open for suggestion)'
  return mappings
    .map((m) => {
      if (m.mapping_type === 'FIELD') return `  ${m.google_field} → FIELD: ${m.config.field ?? '?'}`
      if (m.mapping_type === 'STATIC') return `  ${m.google_field} → STATIC: "${m.config.value ?? ''}"`
      return `  ${m.google_field} → ${m.mapping_type}`
    })
    .join('\n')
}

function buildProductText(products: SupabaseProduct[]): string {
  return products
    .map((p, i) => {
      const variants = (p.variants as Record<string, unknown>[]) ?? []
      const images = (p.images as Record<string, unknown>[]) ?? []
      const v0 = variants[0] ?? {}

      const lines: string[] = [
        `Product ${i + 1}:`,
        `  title: ${p.title ?? ''}`,
        `  vendor: ${p.vendor ?? ''}`,
        `  product_type: ${p.product_type ?? ''}`,
        `  tags: ${(p.tags ?? '').slice(0, 150)}`,
        `  shopify_id: ${p.shopify_id}`,
        `  handle: ${p.handle ?? ''}`,
        `  variants[0].id: ${v0.id ?? ''}`,
        `  variants[0].price: ${v0.price ?? ''}`,
        `  variants[0].compare_at_price: ${v0.compare_at_price ?? ''}`,
        `  variants[0].sku: ${v0.sku ?? ''}`,
        `  variants[0].barcode: ${v0.barcode ?? ''}`,
        `  variants[0].inventory_quantity: ${v0.inventory_quantity ?? ''}`,
        `  variants[0].option1: ${v0.option1 ?? ''}`,
        `  variants[0].option2: ${v0.option2 ?? ''}`,
        `  variants[0].weight: ${v0.weight ?? ''}`,
        `  images[0].src: ${images[0]?.src ? String(images[0].src).slice(0, 80) : '(none)'}`,
        `  images[1].src: ${images[1]?.src ? '(image URL)' : '(none)'}`,
      ]

      if (p.metafields.length > 0) {
        lines.push('  metafields:')
        for (const mf of p.metafields.slice(0, 20)) {
          const val = String(mf.value ?? '').slice(0, 150)
          lines.push(`    ${mf.namespace}.${mf.key} = "${val}"`)
        }
      }

      return lines.join('\n')
    })
    .join('\n\n')
}

// ── Prompt ─────────────────────────────────────────────────────────────────

function buildPrompt(
  feedMode: 'product' | 'variant',
  currency: string,
  locale: string,
  existingMappings: ExistingMapping[],
  metafields: { namespace: string; key: string }[],
  products: SupabaseProduct[]
): string {
  const metafieldsText =
    metafields.length > 0
      ? metafields.map((m) => `  metafield:${m.namespace}.${m.key}`).join('\n')
      : '  (no metafields found)'

  const standardFieldsText = SHOPIFY_STANDARD_FIELDS.map((f) => `  ${f}`).join('\n')
  const existingText = formatMappedFieldsList(existingMappings)
  const productsText = buildProductText(products)

  const idInstruction =
    feedMode === 'variant'
      ? 'id: Use variants[0].id (one feed item per variant). item_group_id: Use the item_group_id field (shared ID for all variants of the same product).'
      : 'id: Use the item_group_id field (one feed item per product).'

  return `You are an expert in Google Shopping Merchant Center and Shopify e-commerce.

=== CONTEXT ===
Feed mode: ${feedMode === 'variant' ? 'VARIANT (one feed item per variant)' : 'PRODUCT (one feed item per product)'}
Store currency: ${currency}
Product data language: ${locale}

Product titles, descriptions and tags in the examples below are in the language "${locale}". All your reasoning and reason-field text MUST be written in English.

=== ALREADY MAPPED FIELDS (SKIP) ===
These fields are already mapped and MUST NOT be overwritten. Suggest NO mapping for any of these fields — not even if you think the current one is wrong:
${existingText}

=== GOOGLE SHOPPING FIELD REQUIREMENTS ===
${idInstruction}
title: Max 150 chars. No HTML. No promotional phrases ("buy now", "free shipping", etc.).
description: Max 5000 chars. No HTML tags. No promotional phrases. No links. Use body_html as source — but the mapping type must be set to STRIP_HTML to remove HTML.
link: Full URL with https://. Use the "url" field.
image_link: Full https:// URL. No watermarks. No text overlay.
additional_image_link: Same requirements as image_link.
availability: EXACTLY one of: in_stock, out_of_stock, preorder, backorder. Requires inventory calculation — skip.
price: Format "NUMBER CURRENCY" with period as decimal separator and a space before the currency code. Example: "199.00 ${currency}". variants[0].price contains only the number — append " ${currency}" as a suffix via PREFIX_SUFFIX mapping (but for now suggest it as a field).
sale_price: Same format as price. Only if compare_at_price exists and is higher than price.
brand: Max 70 chars. Not "N/A" or "Generic". Use vendor.
gtin: Digits only. Max 14 digits. Valid formats: UPC (12 digits), EAN (13 digits), ISBN (13 digits). Use variants[0].barcode.
mpn: Max 70 chars. Manufacturer part number. Use variants[0].sku.
condition: EXACTLY one of: new, refurbished, used. Analyze the products — ALWAYS suggest as a static mapping.
google_product_category: Must be an integer ID from Google's official taxonomy. NOT a text string. Only if you are confident about the category.
product_type: Max 750 chars. Use path-style format "Category > Subcategory". Use the product_type field.
item_group_id: Shared ID for all variants. Max 50 chars. Use the item_group_id field.
color: Max 100 chars. No numbers or hex codes. Separate colors with /. Use option fields or metafields.
size: Max 100 chars. Use option fields or metafields.
gender: EXACTLY one of: male, female, unisex. Only if relevant to the product type.
age_group: EXACTLY one of: newborn, infant, toddler, kids, adult. Only if relevant.
material: Max 200 chars. Separate materials with /. Use metafields when available.
pattern: Max 100 chars. Use metafields when available.
size_type: EXACTLY one of: regular, petite, maternity, big, tall, plus.
size_system: EXACTLY one of: US, UK, EU, DE, FR, JP, CN, IT, BR, MEX, AU.
shipping_weight: Format "NUMBER unit". Example: "1.5 kg". Units: lb, oz, g, kg. Use variants[0].weight (it is in grams — use suffix " g").

=== AVAILABLE SHOPIFY FIELDS ===
Standard fields:
${standardFieldsText}

Metafields in this store:
${metafieldsText}

=== EXAMPLE PRODUCTS ===
${productsText}

=== INSTRUCTIONS ===
1. Analyze field names and data formats — not what the store sells
2. ONLY suggest mappings for fields that are NOT already on the list above — never overwrite an existing mapping
3. Skip "availability" — it requires calculation
4. Use "high" confidence only when there is a direct technical match between field names or data formats
5. Return ONLY a JSON array — no explanation, no markdown, no comments

IMPORTANT RULES:
- Make suggestions ONLY based on technical field structure and data format — not on what the store sells
- NEVER mention what the store sells in the reason field — keep explanations technical and generic
- For the condition field: ONLY suggest a static mapping if you see direct evidence in the product data (e.g. a metafield called "condition") — otherwise skip condition
- For google_product_category: ONLY suggest a metafield if you can see that the metafield contains an integer ID — never a hard-coded category ID
- custom_label suggestions must ONLY be based on the metafield existing and having consistent values across the products — not on what the value means for the specific industry
- confidence "high" may only be used when there is a direct technical match between field names or data formats
- The reason field must explain the technical match — not the underlying business logic
- All reason-field text MUST be in English regardless of the product data language

JSON format (both types):
[
  { "google_field": "title", "shopify_field": "title", "mapping_type": "field", "confidence": "high", "reason": "Direct name match" },
  { "google_field": "condition", "shopify_field": null, "mapping_type": "static", "static_value": "new", "confidence": "high", "reason": "Reasoning based on product analysis" }
]`
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 500 })
  }

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) return NextResponse.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return NextResponse.json({ error: 'Feed not found' }, { status: 404 })

  // Cost guard: cap AI-suggestion calls per user (Anthropic spend).
  try {
    await enforceRateLimit(user.id, 'ai_suggest')
  } catch (err) {
    return errorResponse(err, 'POST /api/mapping/ai-suggest')
  }

  // Existing mappings come from the client (live state — may include unsaved
  // changes the user just made). The route used to load these from
  // feed_mappings, but that ignored uncommitted edits. The client only sends
  // mappings with a non-empty mapping_type; we treat anything else as
  // "open for suggestion".
  const body = (await req.json().catch(() => ({}))) as {
    existingMappings?: ExistingMapping[]
  }
  const activeMappings: ExistingMapping[] = Array.isArray(body.existingMappings)
    ? body.existingMappings.filter(
        (m) => m && typeof m === 'object' && m.mapping_type && m.mapping_type !== ''
      )
    : []
  const mappedFields = new Set(activeMappings.map((m) => m.google_field))

  const db = adminClient()

  const [
    { data: settingsData },
    { data: shopSettingsData },
    { data: metafieldRows },
    { data: productRows },
  ] = await Promise.all([
    db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
    db.from('shop_settings').select('currency, selected_locale').eq('feed_id', feedId).maybeSingle(),
    db.from('product_metafields').select('namespace, key').eq('feed_id', feedId).limit(200),
    db.from('products').select('*, metafields:product_metafields(*)').eq('feed_id', feedId).eq('status', 'active').limit(50),
  ])

  const feedMode = (settingsData?.feed_mode as 'product' | 'variant') ?? 'product'
  const currency = shopSettingsData?.currency ?? 'USD'
  const locale = shopSettingsData?.selected_locale ?? 'en'

  // Deduplicate metafields
  const seen = new Set<string>()
  const uniqueMetafields: { namespace: string; key: string }[] = []
  for (const mf of metafieldRows ?? []) {
    const k = `${mf.namespace}.${mf.key}`
    if (!seen.has(k)) { seen.add(k); uniqueMetafields.push(mf) }
  }

  // 5 random products
  const allProducts = (productRows ?? []) as SupabaseProduct[]
  const sampleProducts = [...allProducts].sort(() => Math.random() - 0.5).slice(0, 5)

  const prompt = buildPrompt(feedMode, currency, locale, activeMappings, uniqueMetafields, sampleProducts)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = message.content[0]?.type === 'text' ? message.content[0].text.trim() : '[]'

  let suggestions: unknown[] = []
  try {
    suggestions = JSON.parse(raw)
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/)
    if (match) {
      try { suggestions = JSON.parse(match[1]) } catch { suggestions = [] }
    }
  }

  if (!Array.isArray(suggestions)) suggestions = []

  // Defense in depth: drop any suggestion targeting an already-mapped field
  // even if Claude ignored the prompt instruction.
  const filtered = suggestions.filter((s) => {
    if (!s || typeof s !== 'object') return false
    const gf = (s as { google_field?: unknown }).google_field
    return typeof gf === 'string' && !mappedFields.has(gf)
  })

  return NextResponse.json({ suggestions: filtered })
}
