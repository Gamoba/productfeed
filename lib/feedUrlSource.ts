// Product source for projects with source_type = 'feed_url'.
//
// Some clients give us no backend access — only a public product feed URL,
// usually Google Shopping RSS 2.0 (or Atom) with g: fields. On sync we GET that
// URL, parse its <item>/<entry> elements and turn each one into the same product
// row shape the Shopify sync produces (lib/sync.ts → SourceProduct), so the
// generator, mappings, filters, AI titles and buckets work unchanged.
//
// Field placement mirrors Shopify's conventions so the default mappings
// (lib/defaultMappings.ts) produce a correct feed without edits:
//   g:price / g:sale_price → variants[0].price is what the customer pays now,
//     variants[0].compare_at_price the original price when on sale.
//   g:availability → variants[0].inventory_quantity 1 / 0 (raw value is kept
//     as metafield feed.availability for exact mapping).
// ProfitMetrics feeds (pm: namespace) are read too: pm:price_currency fills a
//   missing price currency, pm:num_stock gives the stock when there is no
//   g:availability, pm:sku the SKU when there is no g:mpn. pm:price_buy and
//   the rest stay feed.* metafields.
//   g:link → products.link (used verbatim for the `url` source field).
// Every other field is kept as a metafield in namespace "feed" (feed.gtin,
// feed.mpn, feed.condition, …), so it can be mapped and filtered by name.
//
// The fetch is a plain GET of a URL the user typed in, so it is guarded against
// server-side request forgery: http(s) only, no embedded credentials, and the
// host (and every redirect hop) must resolve to a public address.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { SourceProduct } from '@/lib/sync'
import { AppError } from '@/lib/errors'

const FETCH_TIMEOUT_MS = 120_000
const MAX_BYTES = 200 * 1024 * 1024 // 200 MB — the Umbraco feed we target is ~17 MB
const MAX_REDIRECTS = 5

// ── URL safety ──────────────────────────────────────────────────────────────

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224 // multicast + reserved
    )
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7))
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('ff')
  )
}

// Parses and checks a user-supplied feed URL. Throws an AppError (400) with a
// readable message when it is not an acceptable public http(s) URL.
export async function assertPublicFeedUrl(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new AppError('The feed URL is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AppError('The feed URL must start with https:// or http://')
  }
  if (url.username || url.password) {
    throw new AppError('The feed URL cannot contain a username or password')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new AppError('The feed URL must point to a public address')
  }
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address)
    } catch {
      throw new AppError(`Could not look up the host "${host}"`)
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new AppError('The feed URL must point to a public address')
  }
  return url
}

// HTTP Basic Auth login for a protected feed. Stored encrypted on the project
// (lib/feedAuth.ts); only ever held in plaintext server-side during a fetch.
export type FeedAuth = { username: string; password: string }

function basicAuthHeader(auth: FeedAuth): string {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`
}

// GETs the feed and returns its body as text. Redirects are followed manually so
// every hop is re-checked; the body is streamed with a size cap. A Basic Auth
// login is sent only to the feed URL's own origin — a redirect to another origin
// is followed without it, so the login can't leak to a third party.
export async function fetchFeedText(rawUrl: string, auth?: FeedAuth | null): Promise<string> {
  let url = await assertPublicFeedUrl(rawUrl)
  const authOrigin = url.origin
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    for (let hop = 0; ; hop++) {
      let res: Response
      const headers: Record<string, string> = {
        Accept: 'application/xml, text/xml, application/rss+xml, */*',
      }
      if (auth && url.origin === authOrigin) headers.Authorization = basicAuthHeader(auth)
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers,
        })
      } catch (err) {
        const reason = controller.signal.aborted ? 'timeout' : err instanceof Error ? err.message : 'network error'
        throw new AppError(`Could not fetch the feed (${reason})`)
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop >= MAX_REDIRECTS) throw new AppError('The feed URL redirects too many times')
        url = await assertPublicFeedUrl(new URL(res.headers.get('location')!, url).toString())
        continue
      }
      if (res.status === 401 || res.status === 403) {
        const wantsBasic = /^\s*basic\b/i.test(res.headers.get('www-authenticate') ?? '')
        throw new AppError(
          auth
            ? `The feed rejected the login (HTTP ${res.status}). Check the username and password`
            : wantsBasic
              ? 'The feed requires a login (HTTP Basic Auth). Enter a username and password'
              : `The feed responded with HTTP ${res.status} (access denied)`
        )
      }
      if (!res.ok) {
        throw new AppError(`The feed responded with HTTP ${res.status}`)
      }

      const declared = Number(res.headers.get('content-length') ?? '0')
      if (declared > MAX_BYTES) throw new AppError('The feed is larger than 200 MB')
      if (!res.body) return ''

      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_BYTES) {
          await reader.cancel()
          throw new AppError('The feed is larger than 200 MB')
        }
        chunks.push(value)
      }
      const buf = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        buf.set(c, offset)
        offset += c.byteLength
      }
      // TextDecoder strips a UTF-8 BOM. Google feeds are UTF-8 by spec.
      return new TextDecoder('utf-8').decode(buf)
    }
  } finally {
    clearTimeout(timer)
  }
}

// ── XML parsing ─────────────────────────────────────────────────────────────
//
// Product feeds are flat: <item> elements whose children are text fields, with
// the odd nested group (g:shipping, g:tax). A focused scanner handles that
// reliably without adding an XML dependency.

export type FeedItem = Record<string, string[]>

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
  })
}

// Text content of an element body: CDATA sections verbatim, everything else
// entity-decoded. Nested child elements are flattened to their texts joined
// with ":" — Google's own notation for grouped fields (e.g. "DK::Standard:49.00 DKK").
function textOf(body: string): string {
  // Only real child elements make a nested group — a "<" inside CDATA is text.
  if (!/</.test(body.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''))) {
    return body
      .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
      .map((part) => (part.startsWith('<![CDATA[') ? part.slice(9, -3) : decodeEntities(part)))
      .join('')
      .trim()
  }
  const children = parseFields(body)
  const parts = Object.values(children).flat()
  return parts.length ? parts.join(':') : decodeEntities(body.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

const FIELD_RE =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\2\s*>)/g

// Direct child fields of an element body. Namespace prefixes are dropped
// (g:price and price both become "price"); repeated fields keep every value.
function parseFields(body: string): FeedItem {
  const out: FeedItem = {}
  for (const m of body.matchAll(FIELD_RE)) {
    const name = m[2]
    if (!name) continue // CDATA / comment between fields
    const value = m[3] === undefined ? '' : textOf(m[3])
    ;(out[name] ??= []).push(value)
  }
  return out
}

// All <item> (RSS) or <entry> (Atom) elements of a product feed.
export function parseProductFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = []
  for (const m of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/g)) {
    items.push(parseFields(m[2]))
  }
  return items
}

// ── Item → product row ──────────────────────────────────────────────────────

const first = (item: FeedItem, key: string): string => (item[key]?.find((v) => v !== '') ?? '').trim()

// "34.00 DKK", "DKK 34.00", "34,00 DKK", "1.234,50 DKK", "1,234.50 USD"
// → { amount: "34.00", currency: "DKK" }. With both separators present the last
// one is the decimal mark; a lone comma is decimal unless it groups thousands.
export function parsePrice(raw: string): { amount: string; currency: string } | null {
  const currency = raw.match(/\b[A-Z]{3}\b/)?.[0] ?? ''
  let num = raw.replace(/[^\d.,]/g, '')
  if (!num) return null
  const lastComma = num.lastIndexOf(',')
  const lastDot = num.lastIndexOf('.')
  if (lastComma !== -1 && lastDot !== -1) {
    num = lastComma > lastDot ? num.replace(/\./g, '').replace(',', '.') : num.replace(/,/g, '')
  } else if (lastComma !== -1) {
    num = /^\d{1,3}(,\d{3})+$/.test(num) ? num.replace(/,/g, '') : num.replace(',', '.')
  }
  const n = Number(num)
  if (!Number.isFinite(n)) return null
  return { amount: n.toFixed(2), currency }
}

// Fields consumed into product columns / the variant. Everything else becomes a
// feed.* metafield. availability, gtin and mpn are deliberately kept as
// metafields too, so their exact source value can be mapped by name.
const CORE_FIELDS = new Set([
  'id',
  'title',
  'description',
  'link',
  'image_link',
  'additional_image_link',
  'price',
  'sale_price',
  'brand',
  'product_type',
  // Atom/RSS channel-style fields that carry no product data
  'updated',
  'summary',
])

export type FeedConversion = {
  products: SourceProduct[]
  skippedNoId: number
  duplicateIds: number
}

export function feedItemsToProducts(items: FeedItem[]): FeedConversion {
  const products: SourceProduct[] = []
  const seen = new Set<string>()
  let skippedNoId = 0
  let duplicateIds = 0

  for (const item of items) {
    const id = first(item, 'id')
    if (!id) {
      skippedNoId++
      continue
    }
    if (seen.has(id)) {
      duplicateIds++
      continue
    }
    seen.add(id)

    const regular = parsePrice(first(item, 'price'))
    const sale = parsePrice(first(item, 'sale_price'))
    const onSale = !!(regular && sale && Number(sale.amount) < Number(regular.amount))
    // ProfitMetrics feeds (pm:) give a bare <g:price> and the currency in
    // pm:price_currency — used only when the price itself carries none.
    const fallbackCurrency = first(item, 'price_currency').toUpperCase()
    const currency =
      (onSale ? sale?.currency : regular?.currency) ||
      regular?.currency ||
      sale?.currency ||
      (/^[A-Z]{3}$/.test(fallbackCurrency) ? fallbackCurrency : null)

    // Stock: g:availability when present (unchanged behaviour: 1 / 0). Without
    // it, a ProfitMetrics pm:num_stock gives the real quantity. With neither,
    // the product counts as in stock, as before.
    const availability = first(item, 'availability').toLowerCase().replace(/\s+/g, '_')
    const numStock = first(item, 'num_stock')
    const stockQty = availability === '' && /^-?\d+(\.\d+)?$/.test(numStock) ? Math.max(0, Math.floor(Number(numStock))) : null
    const inStock =
      stockQty !== null
        ? stockQty > 0
        : availability === '' || availability === 'in_stock' || availability === 'preorder' || availability === 'backorder'

    const imageUrls = [...(item.image_link ?? []), ...(item.additional_image_link ?? [])]
      .map((s) => s.trim())
      .filter(Boolean)

    const metafields = Object.entries(item)
      .filter(([key]) => !CORE_FIELDS.has(key))
      .map(([key, values]) => ({
        namespace: 'feed',
        key,
        value: values.filter((v) => v !== '').join(', '),
        type: 'single_line_text_field',
      }))
      .filter((mf) => mf.value !== '')

    products.push({
      id,
      title: first(item, 'title') || null,
      body_html: first(item, 'description') || null,
      vendor: first(item, 'brand') || null,
      product_type: first(item, 'product_type') || null,
      status: 'active',
      handle: null,
      link: first(item, 'link') || null,
      published_at: null,
      tags: '',
      images: imageUrls.map((src, i) => ({
        id: i + 1,
        src,
        alt: null,
        position: i + 1,
        variant_ids: [],
      })),
      variants: [
        {
          id,
          title: 'Default Title',
          price: onSale ? sale!.amount : (regular?.amount ?? sale?.amount ?? null),
          compare_at_price: onSale ? regular!.amount : null,
          currency,
          sku: first(item, 'mpn') || first(item, 'sku') || null,
          barcode: first(item, 'gtin') || null,
          inventory_quantity: stockQty ?? (inStock ? 1 : 0),
          option1: null,
          option2: null,
          option3: null,
        },
      ],
      options: [],
      collections: [],
      metafields,
    })
  }

  return { products, skippedNoId, duplicateIds }
}

// Fetch + parse + convert. Throws an AppError when the URL yields no products,
// so a wrong URL (an HTML page, an empty response) never wipes a feed's
// existing products during sync.
export async function fetchFeedUrlProducts(
  feedUrl: string,
  auth?: FeedAuth | null
): Promise<FeedConversion & { itemCount: number }> {
  const xml = await fetchFeedText(feedUrl, auth)
  const items = parseProductFeed(xml)
  const conversion = feedItemsToProducts(items)
  if (conversion.products.length === 0) {
    throw new AppError(
      items.length === 0
        ? 'No products found in the feed. Expected a Google Shopping feed (RSS/XML with <item> elements)'
        : 'The feed contains items, but none of them has an id'
    )
  }
  return { ...conversion, itemCount: items.length }
}
