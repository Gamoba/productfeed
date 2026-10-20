// Pin to a version Shopify still supports. 2025-07 has been retired: requests
// against it are answered by 2025-10 anyway (verified via the served
// X-Shopify-Api-Version header), so the old value only hid which schema we were
// actually talking to. Bumping is a no-op at runtime and makes the pin honest.
export const API_VERSION = '2025-10'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseGid(gid: string): number {
  const match = gid.match(/\/(\d+)$/)
  return match ? parseInt(match[1], 10) : 0
}

function refOf(gid: string): string {
  const match = gid.match(/\/(\d+)$/)
  return match ? match[1] : gid
}

function optionalRef(gid: string | null | undefined): string | null {
  return gid ? refOf(gid) : null
}

/** Shopify money as a number, or null. An absent amount is not 0.00. */
function toAmount(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ShopifyMetafield = {
  id: number
  namespace: string
  key: string
  value: string
  type: string
  description: string | null
  owner_id: number
  created_at: string
  updated_at: string
  owner_resource: string
}

export type PresentmentPrice = {
  price: { amount: string; currency_code: string }
  compare_at_price: { amount: string; currency_code: string } | null
}

export type ShopifyVariant = {
  id: number
  title: string
  price: string
  sku: string
  compare_at_price: string | null
  option1: string | null
  option2: string | null
  option3: string | null
  barcode: string | null
  inventory_quantity: number
  weight: number
  weight_unit: string
  requires_shipping: boolean
  taxable: boolean
  inventory_management: string | null
  inventory_policy: string
  fulfillment_service: string
  created_at: string
  updated_at: string
  presentment_prices?: PresentmentPrice[]
  // ISO 4217 currency code for `price` / `compare_at_price` — set when a market
  // overlay has been applied (e.g. EUR for the France market). Absent on raw
  // REST responses, where prices are always in the shop's base currency.
  currency?: string
}

export type ShopifyImage = {
  id: number
  src: string
  alt: string | null
  width: number
  height: number
  position: number
  variant_ids: number[]
}

export type ShopifyOption = {
  id: number
  name: string
  position: number
  values: string[]
}

export type ShopifyProduct = {
  id: number
  title: string
  body_html: string
  vendor: string
  product_type: string
  created_at: string
  updated_at: string
  published_at: string | null
  handle: string
  status: 'active' | 'draft' | 'archived'
  tags: string
  published_scope: string
  template_suffix: string | null
  admin_graphql_api_id: string
  variants: ShopifyVariant[]
  options: ShopifyOption[]
  images: ShopifyImage[]
  image: ShopifyImage | null
  // Enriched
  metafields: ShopifyMetafield[]
  collections: string[]
}

export type ShopifyCollection = {
  id: number
  title: string
  handle: string
  body_html: string | null
  updated_at: string
  published_at: string
  sort_order: string
  admin_graphql_api_id: string
}

// What happened when metaobject references were translated from GIDs to their
// display values. Carried out of the fetch so the sync can TELL the user when a
// feed is about to be built on raw Shopify IDs, instead of silently emitting
// "gid://shopify/Metaobject/123" where a region name belongs.
export type MetaobjectSummary = {
  // Distinct GIDs found across the fetched products.
  total: number
  // How many of those we got a display value for.
  resolved: number
  // Shopify refused the lookup outright: the token has no `read_metaobjects`
  // scope. Nothing is resolvable until the token is re-issued, so this is a
  // different (and fixable) problem from a handful of stragglers.
  accessDenied: boolean
}

export type ShopifyData = {
  products: ShopifyProduct[]
  metaobjects: MetaobjectSummary
}

// ── Shopify Markets types ──────────────────────────────────────────────────────

export type ShopifyMarketLocale = {
  locale: string
  name: string
  primary: boolean
}

export type ShopifyMarket = {
  id: string
  name: string
  handle: string
  status: 'ACTIVE' | 'DRAFT'
  type: string           // 'PRIMARY' | 'SECONDARY' etc.
  currency: string       // ISO 4217 e.g. "DKK" — falls back to the shop currency
  // Only present when the market has explicit currency settings; null on stores
  // that inherit the shop currency, so render it conditionally.
  currencyName: string | null
  defaultLocale: ShopifyMarketLocale | null
  alternateLocales: ShopifyMarketLocale[]
  marketUrl: string | null
  // ISO country codes covered by this market (e.g. ["DE"] or ["DE","AT","CH"]).
  // Used as the `country` parameter for contextualPricing — we send the first
  // entry by default; multi-country markets may need UI to pick one explicitly.
  countryCodes: string[]
}

// Shopifys maksimale page-size for REST products.json. fetchAllPages
// paginerer via Link-header indtil der ikke er flere sider — ingen øvre
// grænse på totalen.
const PRODUCT_LIMIT = 250

// Bulk-fetch product metafields via GraphQL nodes(ids). One call replaces N
// REST calls. Batch size and metafields(first:N) are tuned so the requested
// query cost stays well below Shopify's 2000-point bucket:
//   requested cost ≈ batch * (1 + first + 1) = 15 * 52 = 780 cost
// Products with more than FIRST_METAFIELDS metafields get truncated — the
// previous REST path paginated up to 250 per product, so this is a slight
// regression for very metafield-heavy catalogs. Realistic stores have ≤30.
type ProductMetafieldsResponse = {
  nodes: Array<{
    id: string
    metafields: {
      nodes: Array<{
        id: string
        namespace: string
        key: string
        value: string
        type: string
        description: string | null
        createdAt: string
        updatedAt: string
      }>
    }
  } | null>
}

// Bulk-fetch collection memberships per product via GraphQL. Same cost
// shape as fetchProductMetafieldsBulk (15 products × first:50 ≈ 780 cost
// per call). Returns title strings — that's what the rest of the pipeline
// already expects (ShopifyProduct.collections is string[], filter rules
// match against title strings).
type ProductCollectionsResponse = {
  nodes: Array<{
    id: string
    collections: { nodes: Array<{ title: string }> }
  } | null>
}

// Bulk-fetch per-variant unit cost ("Cost per item" in the admin). Same
// nodes(ids) shape as the two bulk fetches above; cost is ~2 points per variant,
// so the batch is smaller to stay clear of the 2000-point bucket:
//   requested cost ≈ 15 * (1 + 100 * 2) ≈ 3000 — too high, hence BATCH_SIZE 8.
//
// unitCost is NULLABLE and that is load-bearing: a variant with no cost entered
// is not a variant with zero cost. It stays null all the way to the UI so that
// "unknown margin" never renders as "100% margin".
type VariantCostsResponse = {
  nodes: Array<{
    id: string
    variants: {
      nodes: Array<{
        id: string
        inventoryItem: { unitCost: { amount: string; currencyCode: string } | null } | null
      }>
    }
  } | null>
}

/**
 * One place a shop holds stock.
 *
 * Fetched so the app can tell whether variants[].inventory_quantity is a total
 * across several places. A market-scoped feed cannot assume all of a multi-
 * location total is reachable from its own market, and the only honest move is
 * to say so — which requires knowing the count.
 *
 * `shipsInventory` and `active` both matter: a location that is inactive, or
 * that exists only as a pickup point, does not contribute sellable stock, so
 * counting it would raise a warning about ambiguity that isn't there.
 */
export type ShopifyLocationInfo = {
  id: string
  name: string
  active: boolean
  shipsInventory: boolean
}

export type VariantCost = {
  productId: number
  variantId: number
  /** null when the merchant has not entered a cost. Never coerced to 0. */
  unitCost: number | null
  currency: string | null
}

// ── Orders, refunds, returns ────────────────────────────────────────────────
//
// Shaped to be STORED, not rendered: these types mirror the columns in
// migration 041 rather than the screens that read them. The reason is the
// 60-day visibility ceiling — see that migration's header. Anything not
// captured on the first pass is unrecoverable once an order ages out, so the
// mapping below keeps every field the API offers on these objects, including
// ones no current feature reads.
//
// Money is carried in both bases throughout. `null` where Shopify returned
// nothing; never coerced to 0, because a missing amount and a zero amount are
// different claims about an order.

export type Money = {
  shop: number | null
  presentment: number | null
}

export type ShopifyOrderLineItem = {
  lineItemRef: string
  /** Null when the product has been deleted from Shopify since the sale. */
  productRef: string | null
  variantRef: string | null
  sku: string | null
  title: string | null
  variantTitle: string | null
  quantity: number
  price: Money
  totalDiscount: Money
}

export type ShopifyRefundLineItem = {
  refundLineRef: string
  lineItemRef: string | null
  productRef: string | null
  variantRef: string | null
  quantity: number
  subtotal: Money
  totalTax: Money
  /** RETURN | CANCEL | LEGACY_RESTOCK | NO_RESTOCK | null */
  restockType: string | null
}

export type ShopifyRefund = {
  refundRef: string
  createdAt: string
  processedAt: string | null
  /**
   * Null when no return is attached — a cancellation, a goodwill refund, a
   * price match. Keeping this nullable is what lets return-driven losses be
   * counted apart from refunds in general.
   */
  returnRef: string | null
  note: string | null
  totalRefunded: Money
  lineItems: ShopifyRefundLineItem[]
}

export type ShopifyReturnLineItem = {
  returnLineRef: string
  lineItemRef: string | null
  productRef: string | null
  variantRef: string | null
  quantity: number
  /** SIZE_TOO_SMALL | NOT_AS_DESCRIBED | DEFECTIVE | … | null */
  returnReason: string | null
  returnReasonNote: string | null
}

export type ShopifyReturn = {
  returnRef: string
  name: string | null
  /** OPEN | CLOSED | DECLINED | REQUESTED | CANCELED */
  status: string | null
  createdAt: string | null
  closedAt: string | null
  totalQuantity: number
  lineItems: ShopifyReturnLineItem[]
}

export type ShopifyOrder = {
  orderRef: string
  name: string | null
  createdAt: string
  updatedAt: string
  processedAt: string | null
  cancelledAt: string | null
  /** Shipping country, falling back to billing. Null on orders with neither. */
  countryCode: string | null
  shopCurrency: string | null
  presentmentCurrency: string | null
  totalPrice: Money
  subtotalPrice: Money
  totalTax: Money
  totalDiscounts: Money
  totalRefunded: Money
  financialStatus: string | null
  fulfillmentStatus: string | null
  test: boolean
  lineItems: ShopifyOrderLineItem[]
  refunds: ShopifyRefund[]
  returns: ShopifyReturn[]
}

export type OrderFetchPage = {
  orders: ShopifyOrder[]
  hasNextPage: boolean
  endCursor: string | null
}

type ShopLocaleGql = { locale: string; name: string; primary: boolean }

// As of Admin API 2025-04+, MarketWebPresence.rootUrl was replaced with rootUrls
// (a list of { locale, url } so each locale can have its own URL).
//
// The shop-level fields are FALLBACKS, not decoration. A market only carries its
// own currencySettings / webPresences when the merchant has configured Markets
// explicitly. On a single-market store (the common case) Shopify returns
// `currencySettings: null` and `webPresences: { nodes: [] }` — the market simply
// inherits the shop's currency, locales and domain. Without these fallbacks such
// a store yields no currency at all, and product URLs have no domain to build on.
const MARKETS_QUERY = `{
  shop {
    currencyCode
    primaryDomain { url }
  }
  shopLocales(published: true) { locale name primary }
  markets(first: 50) {
    nodes {
      id
      name
      handle
      status
      type
      currencySettings {
        baseCurrency {
          currencyCode
          currencyName
        }
      }
      webPresences(first: 10) {
        nodes {
          rootUrls {
            locale
            url
          }
          defaultLocale { locale name primary }
          alternateLocales { locale name primary }
        }
      }
      regions(first: 50) {
        nodes {
          ... on MarketRegionCountry {
            code
          }
        }
      }
    }
  }
}`

// One page of orders with everything hanging off them.
//
// ── WHY ASCENDING BY updated_at ────────────────────────────────────────────
// The sync advances a watermark. Walking oldest-first means a run that dies
// halfway has still durably stored a contiguous prefix, and the watermark can
// be moved to the last order actually written. Newest-first would leave a hole
// in the middle that nothing later would ever revisit.
//
// ── WHY THE PAGE IS SMALL ──────────────────────────────────────────────────
// Cost, not politeness. Each order drags up to 50 line items, its refunds with
// their own lines, and its returns with theirs, so a page of 10 already
// approaches Shopify's per-query cost ceiling. shopifyGraphQL backs off on
// THROTTLED, but a query whose SINGLE cost exceeds the bucket can never
// succeed at any pace.
//
// ── LIMITS ARE DELIBERATE, NOT DEFAULTS ────────────────────────────────────
// An order with more than 50 distinct line items is a wholesale order, not the
// ecommerce case this measures, and truncating its tail costs a rounding error
// on a return rate. The sync counts what it truncated rather than pretending
// otherwise (see lib/shopifyOrders.ts).
const ORDERS_QUERY = `query Orders($first: Int!, $after: String, $q: String!) {
  orders(first: $first, after: $after, query: $q, sortKey: UPDATED_AT, reverse: false) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      updatedAt
      processedAt
      cancelledAt
      test
      displayFinancialStatus
      displayFulfillmentStatus
      currencyCode
      presentmentCurrencyCode
      shippingAddress { countryCodeV2 }
      billingAddress { countryCodeV2 }
      totalPriceSet { shopMoney { amount } presentmentMoney { amount } }
      subtotalPriceSet { shopMoney { amount } presentmentMoney { amount } }
      totalTaxSet { shopMoney { amount } presentmentMoney { amount } }
      totalDiscountsSet { shopMoney { amount } presentmentMoney { amount } }
      totalRefundedSet { shopMoney { amount } presentmentMoney { amount } }
      lineItems(first: 50) {
        nodes {
          id
          sku
          title
          variantTitle
          quantity
          product { id }
          variant { id }
          originalUnitPriceSet { shopMoney { amount } presentmentMoney { amount } }
          totalDiscountSet { shopMoney { amount } presentmentMoney { amount } }
        }
      }
      refunds {
        id
        createdAt
        note
        totalRefundedSet { shopMoney { amount } presentmentMoney { amount } }
        return { id }
        refundLineItems(first: 50) {
          nodes {
            quantity
            restockType
            subtotalSet { shopMoney { amount } presentmentMoney { amount } }
            totalTaxSet { shopMoney { amount } presentmentMoney { amount } }
            lineItem {
              id
              product { id }
              variant { id }
            }
          }
        }
      }
      returns(first: 10) {
        nodes {
          id
          name
          status
          totalQuantity
          createdAt
          closedAt
          returnLineItems(first: 50) {
            nodes {
              ... on ReturnLineItem {
                id
                quantity
                returnReason
                returnReasonNote
                fulfillmentLineItem {
                  lineItem {
                    id
                    product { id }
                    variant { id }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`

type MoneySetGql = {
  shopMoney?: { amount?: string | null } | null
  presentmentMoney?: { amount?: string | null } | null
} | null

type OrdersResponse = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: Array<{
      id: string
      name?: string | null
      createdAt: string
      updatedAt: string
      processedAt?: string | null
      cancelledAt?: string | null
      test?: boolean | null
      displayFinancialStatus?: string | null
      displayFulfillmentStatus?: string | null
      currencyCode?: string | null
      presentmentCurrencyCode?: string | null
      shippingAddress?: { countryCodeV2?: string | null } | null
      billingAddress?: { countryCodeV2?: string | null } | null
      totalPriceSet?: MoneySetGql
      subtotalPriceSet?: MoneySetGql
      totalTaxSet?: MoneySetGql
      totalDiscountsSet?: MoneySetGql
      totalRefundedSet?: MoneySetGql
      lineItems: {
        nodes: Array<{
          id: string
          sku?: string | null
          title?: string | null
          variantTitle?: string | null
          quantity?: number | null
          product?: { id?: string | null } | null
          variant?: { id?: string | null } | null
          originalUnitPriceSet?: MoneySetGql
          totalDiscountSet?: MoneySetGql
        }>
      }
      refunds: Array<{
        id: string
        createdAt: string
        note?: string | null
        totalRefundedSet?: MoneySetGql
        return?: { id?: string | null } | null
        refundLineItems: {
          nodes: Array<{
            quantity?: number | null
            restockType?: string | null
            subtotalSet?: MoneySetGql
            totalTaxSet?: MoneySetGql
            lineItem?: {
              id?: string | null
              product?: { id?: string | null } | null
              variant?: { id?: string | null } | null
            } | null
          }>
        }
      }>
      returns: {
        nodes: Array<{
          id: string
          name?: string | null
          status?: string | null
          totalQuantity?: number | null
          createdAt?: string | null
          closedAt?: string | null
          returnLineItems: {
            nodes: Array<{
              id?: string | null
              quantity?: number | null
              returnReason?: string | null
              returnReasonNote?: string | null
              fulfillmentLineItem?: {
                lineItem?: {
                  id?: string | null
                  product?: { id?: string | null } | null
                  variant?: { id?: string | null } | null
                } | null
              } | null
            }>
          }
        }>
      }
    }>
  }
}

// ── Response types (localized fetch) ───────────────────────────────────────────

type NodeTranslationsResponse = {
  nodes: Array<{
    id: string
    translations: Array<{ key: string; value: string; outdated: boolean }>
  } | null>
}

type NodeVariantPricesResponse = {
  nodes: Array<{
    id: string
    contextualPricing: {
      price: { amount: string; currencyCode: string }
      compareAtPrice: { amount: string; currencyCode: string } | null
    }
  } | null>
}

type MarketVariantPrice = {
  price: string
  currency: string
  compare_at_price: string | null
}

// ─── Client factory ─────────────────────────────────────────────────────────
//
// Credentials are passed in (shopUrl + accessToken) instead of read from env,
// so each project can have its own Shopify connection. Build one client per
// request from the relevant project's decrypted credentials (see
// lib/projectShopify.ts). The factory preserves all prior behaviour:
// rate-limiting (REST 429/retry-after, GraphQL THROTTLED cost-based back-off,
// up to 4 retries), pagination safety (stop at 20 pages), batch enrichment
// (15 products at a time, in parallel), read-only (no mutations), and the
// hardcoded API version 2025-07.

export type ShopifyCredentials = {
  shopUrl: string
  accessToken: string
}

export type ShopifyClient = {
  fetchProductsWithAllData: () => Promise<ShopifyData>
  fetchProductsLocalized: (
    locale: string,
    currency?: string,
    country?: string
  ) => Promise<ShopifyData>
  fetchMarkets: () => Promise<ShopifyMarket[]>
  fetchGrantedScopes: () => Promise<string[]>
  /**
   * Every location the shop holds stock at. Returns an empty array on failure
   * rather than throwing: not knowing the locations must not be able to break
   * a product sync, and "unknown" is already a state the readers handle.
   */
  fetchLocations: () => Promise<ShopifyLocationInfo[]>
  /** Per-variant "Cost per item". Absent cost stays null, never 0. */
  fetchVariantCostsBulk: (productIds: number[]) => Promise<VariantCost[]>
  /**
   * One page of orders updated at or after `updatedAtMin`, oldest first, with
   * their line items, refunds and returns. The caller pages and persists —
   * see the note on the implementation.
   */
  fetchOrdersPage: (
    updatedAtMin: string,
    cursor?: string | null,
    pageSize?: number
  ) => Promise<OrderFetchPage>
  probeShopifyAccess: () => Promise<{
    httpStatus: number
    grantedScopesHeader: string | null
    apiVersionHeader: string | null
    rawBody: string
  }>
}

export function createShopifyClient({ shopUrl, accessToken }: ShopifyCredentials): ShopifyClient {
  function shopifyUrl(path: string): string {
    return `https://${shopUrl}/admin/api/${API_VERSION}${path}`
  }

  function shopifyHeaders(): Record<string, string> {
    return {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    }
  }

  async function restGet(url: string): Promise<{ json: Record<string, unknown>; link: string }> {
    const MAX_RETRIES = 4

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(url, { headers: shopifyHeaders() })

      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          const retryAfter = parseInt(res.headers.get('retry-after') ?? '2', 10)
          const waitSec = isNaN(retryAfter) ? 2 : retryAfter
          await sleep(waitSec * 1000)
          continue
        }
        throw new Error('Shopify rate limit: too many attempts')
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Shopify REST ${res.status} — ${body}`)
      }

      return { json: await res.json(), link: res.headers.get('link') ?? '' }
    }

    throw new Error('Shopify REST: uventet tilstand')
  }

  async function fetchAllPages<T>(path: string, key: string, maxItems?: number, maxPages = 20): Promise<T[]> {
    const items: T[] = []
    let url: string | null = shopifyUrl(path)
    let page = 1

    while (url && page <= maxPages) {
      const { json, link } = await restGet(url)
      const batch = (json[key] as T[]) ?? []
      items.push(...batch)

      if (maxItems && items.length >= maxItems) break

      const next = link.match(/<([^>]+)>;\s*rel="next"/)
      url = next ? next[1] : null
      page++
    }

    if (page > maxPages) {
      console.error(`Shopify: stoppede ved side ${maxPages} for "${key}" — muligt loop`)
    }

    return maxItems ? items.slice(0, maxItems) : items
  }

  async function shopifyGraphQL<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const MAX_RETRIES = 4

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const res = await fetch(shopifyUrl('/graphql.json'), {
        method: 'POST',
        headers: shopifyHeaders(),
        body: JSON.stringify({ query, variables }),
      })

      if (res.status === 429) {
        if (attempt < MAX_RETRIES) {
          const retryAfter = parseInt(res.headers.get('retry-after') ?? '2', 10)
          await sleep((isNaN(retryAfter) ? 2 : retryAfter) * 1000)
          continue
        }
        throw new Error('Shopify GraphQL rate limit: too many attempts')
      }

      if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`)
      const json = await res.json()
      if (json.errors?.length) {
        // GraphQL throttling returns 200 OK with a THROTTLED extension code.
        // Wait based on the cost gap to currentlyAvailable, then retry.
        const code = json.errors[0]?.extensions?.code as string | undefined
        if (code === 'THROTTLED' && attempt < MAX_RETRIES) {
          const cost = json.extensions?.cost as
            | { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } }
            | undefined
          const requested = cost?.requestedQueryCost ?? 1000
          const available = cost?.throttleStatus?.currentlyAvailable ?? 0
          const restoreRate = cost?.throttleStatus?.restoreRate ?? 100
          const waitMs = Math.max(500, Math.ceil(((requested - available) / restoreRate) * 1000))
          await sleep(waitMs)
          continue
        }
        throw new Error(json.errors[0].message)
      }
      return json.data as T
    }

    throw new Error('Shopify GraphQL: uventet tilstand')
  }

  async function fetchProductMetafieldsBulk(
    productIds: number[]
  ): Promise<Map<number, ShopifyMetafield[]>> {
    const map = new Map<number, ShopifyMetafield[]>()
    if (productIds.length === 0) return map

    const BATCH_SIZE = 15
    const FIRST_METAFIELDS = 50
    const gids = productIds.map((id) => `gid://shopify/Product/${id}`)

    for (let i = 0; i < gids.length; i += BATCH_SIZE) {
      const batch = gids.slice(i, i + BATCH_SIZE)
      try {
        const data = await shopifyGraphQL<ProductMetafieldsResponse>(
          `query ProductMetafields($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                metafields(first: ${FIRST_METAFIELDS}) {
                  nodes {
                    id
                    namespace
                    key
                    value
                    type
                    description
                    createdAt
                    updatedAt
                  }
                }
              }
            }
          }`,
          { ids: batch }
        )

        for (const node of data.nodes) {
          if (!node) continue
          const productId = parseGid(node.id)
          if (!productId) continue
          const list: ShopifyMetafield[] = node.metafields.nodes.map((mf) => ({
            id: parseGid(mf.id),
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
            type: mf.type,
            description: mf.description,
            owner_id: productId,
            created_at: mf.createdAt,
            updated_at: mf.updatedAt,
            owner_resource: 'product',
          }))
          map.set(productId, list)
        }
      } catch (err) {
        console.error(
          `Shopify: metafield-batch ${Math.floor(i / BATCH_SIZE) + 1} fejlede — ${err}`
        )
      }
    }

    return map
  }

  async function fetchLocations(): Promise<ShopifyLocationInfo[]> {
    // One request, no pagination: a shop with more than 50 stocking locations
    // is far outside what this feature is trying to disambiguate, and the
    // answer there ("many") is the same as the answer at 3.
    try {
      const data = await shopifyGraphQL<{
        locations: {
          nodes: Array<{
            id: string
            name: string
            isActive: boolean
            shipsInventory: boolean
          }>
        }
      }>(
        `query Locations {
          locations(first: 50, includeInactive: true) {
            nodes { id name isActive shipsInventory }
          }
        }`
      )

      return (data.locations?.nodes ?? []).map((l) => ({
        id: l.id,
        name: l.name,
        active: Boolean(l.isActive),
        shipsInventory: Boolean(l.shipsInventory),
      }))
    } catch (err) {
      // Same posture as the other auxiliary fetches: this is context, not the
      // payload. Losing it degrades a warning label, not the sync.
      console.error(`Shopify: fetchLocations fejlede — ${err}`)
      return []
    }
  }

  async function fetchVariantCostsBulk(productIds: number[]): Promise<VariantCost[]> {
    const out: VariantCost[] = []
    if (productIds.length === 0) return out

    const BATCH_SIZE = 8
    const FIRST_VARIANTS = 100
    const gids = productIds.map((id) => `gid://shopify/Product/${id}`)

    for (let i = 0; i < gids.length; i += BATCH_SIZE) {
      const batch = gids.slice(i, i + BATCH_SIZE)
      try {
        const data = await shopifyGraphQL<VariantCostsResponse>(
          `query VariantCosts($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                variants(first: ${FIRST_VARIANTS}) {
                  nodes {
                    id
                    inventoryItem { unitCost { amount currencyCode } }
                  }
                }
              }
            }
          }`,
          { ids: batch }
        )

        for (const node of data.nodes) {
          if (!node) continue
          const productId = parseGid(node.id)
          if (!productId) continue
          for (const v of node.variants.nodes) {
            const variantId = parseGid(v.id)
            if (!variantId) continue
            const raw = v.inventoryItem?.unitCost?.amount
            const parsed = raw === undefined || raw === null ? null : Number(raw)
            out.push({
              productId,
              variantId,
              unitCost: parsed !== null && Number.isFinite(parsed) ? parsed : null,
              currency: v.inventoryItem?.unitCost?.currencyCode ?? null,
            })
          }
        }
      } catch (err) {
        // Same posture as the other bulk fetches: one bad batch must not lose the
        // rest. A missing batch leaves those variants without a cost row, which
        // reads as "unknown" — the safe direction.
        console.error(
          `Shopify: variant-cost-batch ${Math.floor(i / BATCH_SIZE) + 1} fejlede — ${err}`
        )
      }
    }

    return out
  }

  async function fetchProductCollectionsBulk(
    productIds: number[]
  ): Promise<Map<number, string[]>> {
    const map = new Map<number, string[]>()
    if (productIds.length === 0) return map

    const BATCH_SIZE = 15
    const FIRST_COLLECTIONS = 50
    const gids = productIds.map((id) => `gid://shopify/Product/${id}`)

    for (let i = 0; i < gids.length; i += BATCH_SIZE) {
      const batch = gids.slice(i, i + BATCH_SIZE)
      try {
        const data = await shopifyGraphQL<ProductCollectionsResponse>(
          `query ProductCollections($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                collections(first: ${FIRST_COLLECTIONS}) {
                  nodes {
                    title
                  }
                }
              }
            }
          }`,
          { ids: batch }
        )

        for (const node of data.nodes) {
          if (!node) continue
          const productId = parseGid(node.id)
          if (!productId) continue
          map.set(
            productId,
            node.collections.nodes.map((c) => c.title).filter(Boolean)
          )
        }
      } catch (err) {
        console.error(
          `Shopify: collections-batch ${Math.floor(i / BATCH_SIZE) + 1} fejlede — ${err}`
        )
      }
    }

    return map
  }

  const METAOBJECT_GID = 'gid://shopify/Metaobject/'

  // Parse a metaobject-reference LIST value (a JSON array of GIDs) into a GID
  // array. Returns [] if the value isn't a parseable array of Metaobject GIDs.
  function parseGidList(value: string): string[] {
    try {
      const arr = JSON.parse(value)
      if (!Array.isArray(arr)) return []
      return arr.filter((g): g is string => typeof g === 'string' && g.startsWith(METAOBJECT_GID))
    } catch {
      return []
    }
  }

  // Whether a metafield value is a single Metaobject GID.
  //
  // Deliberately checked on the VALUE, not on the declared metafield type. A
  // metaobject reference reaches us under several type names —
  // `metaobject_reference`, `mixed_reference`, and their `list.` variants — and
  // gating on an allow-list of type strings silently leaks raw GIDs into the
  // feed for every type not on it. The GID prefix is unambiguous, so the value
  // is the reliable signal.
  function isMetaobjectGid(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith(METAOBJECT_GID) && !/\s/.test(value)
  }

  // Picks the human-readable value of a resolved Metaobject node. displayName
  // is Shopify's built-in human label and is preferred; otherwise fall back to
  // a conventionally-named field (EN/DA), then the first non-empty field.
  function pickMetaobjectValue(node: {
    displayName: string | null
    fields: Array<{ key: string; value: string | null }>
  }): string | null {
    if (node.displayName && node.displayName.trim()) return node.displayName.trim()
    const preferred = ['name', 'label', 'title', 'value', 'navn']
    for (const key of preferred) {
      const f = node.fields.find((x) => x.key.toLowerCase() === key && x.value && x.value.trim())
      if (f?.value) return f.value.trim()
    }
    const first = node.fields.find((x) => x.value && x.value.trim())
    return first?.value?.trim() ?? null
  }

  type MetaobjectField = { key: string; type: string; value: string | null }

  type MetaobjectNodesResponse = {
    nodes: Array<{
      id: string
      displayName: string | null
      fields: MetaobjectField[]
    } | null>
  }

  // A looked-up metaobject: the display value that replaces the GID, plus the
  // fields it was picked from (see metaobjectFieldMetafields).
  type ResolvedMetaobject = { value: string; fields: MetaobjectField[] }

  // Exposes a metaobject's own fields as extra metafields on the product, keyed
  // "<parent key>.<field key>" — so `custom.bundle` → Sorelle's bundle
  // metaobject also yields `custom.bundle.price` and
  // `custom.bundle.compare_at_price`. Without this the feed only ever sees the
  // metaobject's name, while the price that the storefront actually sells a
  // bundle at lives on the metaobject (the bundle's own variant is a 0 kr.
  // shell). The fields are already in the lookup response, so this costs no
  // extra Shopify calls.
  //
  // The dot in the key cannot collide with a real metafield: Shopify keys only
  // allow letters, digits, `-` and `_`. And resolveField splits a
  // "metafield:ns.key" token at its FIRST dot, so "metafield:custom.bundle.price"
  // resolves with no changes there.
  //
  // Reference fields are skipped: their value is another GID (a product, a
  // file), which is no use as feed text and would only clutter the pickers.
  function metaobjectFieldMetafields(
    parent: ShopifyMetafield,
    metaobject: ResolvedMetaobject
  ): ShopifyMetafield[] {
    return metaobject.fields
      .filter((f) => f.value && f.value.trim() && !f.type.endsWith('_reference'))
      .map((f) => ({
        ...parent,
        id: 0,
        key: `${parent.key}.${f.key}`,
        value: f.value as string,
        type: f.type,
        description: null,
      }))
  }

  // Looks up a batch of Metaobject GIDs, writing id → resolved metaobject into `out`.
  //
  // Batches are small on purpose. `nodes(ids:)` is billed per returned object
  // plus its selections, and Shopify rejects any single query costing more than
  // 1000 points outright — that rejection is NOT a THROTTLED error, so
  // shopifyGraphQL throws instead of backing off and retrying. At the previous
  // batch size of 250 a shop with many metaobjects could blow the cost ceiling
  // and lose the whole batch to one caught error, which is exactly how a feed
  // ends up showing `gid://shopify/Metaobject/123` where a region name belongs.
  //
  // A failed batch is split in half and retried rather than dropped, so a single
  // unlucky id can't take its 49 neighbours down with it — EXCEPT when the token
  // has no `read_metaobjects` scope. That failure is total and permanent, so
  // splitting would just turn one denied request into fifty. `denied` latches the
  // first time we see it and every later batch short-circuits.
  async function resolveMetaobjectBatch(
    ids: string[],
    out: Map<string, ResolvedMetaobject>,
    state: { denied: boolean }
  ): Promise<number> {
    if (ids.length === 0 || state.denied) return 0
    try {
      const data = await shopifyGraphQL<MetaobjectNodesResponse>(
        `query ResolveMetaobjects($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Metaobject {
              id
              displayName
              fields { key type value }
            }
          }
        }`,
        { ids }
      )
      for (const node of data.nodes) {
        if (!node) continue
        const value = pickMetaobjectValue(node)
        if (value) out.set(node.id, { value, fields: node.fields })
      }
      return 0
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/read_metaobjects|ACCESS_DENIED/i.test(message)) {
        state.denied = true
        return ids.length
      }
      if (ids.length === 1) {
        console.error(`Shopify: metaobject ${ids[0]} kunne ikke slås op — ${message}`)
        return 1
      }
      const mid = Math.floor(ids.length / 2)
      return (
        (await resolveMetaobjectBatch(ids.slice(0, mid), out, state)) +
        (await resolveMetaobjectBatch(ids.slice(mid), out, state))
      )
    }
  }

  // Resolves metaobject-reference metafield values from opaque GIDs
  // (gid://shopify/Metaobject/...) to their real display values ("Pomerol",
  // "Merlot"), in place. Each unique GID is fetched once and cached, since many
  // products share the same region/grape/country. A single reference also adds
  // the metaobject's fields as extra metafields (metaobjectFieldMetafields).
  // READ-ONLY: a single GraphQL `query`, no mutations. Unresolvable GIDs are
  // left as-is so no data is silently dropped.
  async function resolveMetaobjectReferences(
    products: ShopifyProduct[]
  ): Promise<MetaobjectSummary> {
    // 1. Collect unique GIDs across all products, by value shape (see
    //    isMetaobjectGid on why not by metafield type).
    const gidSet = new Set<string>()
    for (const p of products) {
      for (const mf of p.metafields) {
        if (isMetaobjectGid(mf.value)) gidSet.add(mf.value)
        else for (const g of parseGidList(mf.value)) gidSet.add(g)
      }
    }
    if (gidSet.size === 0) return { total: 0, resolved: 0, accessDenied: false }

    // 2. Batch-resolve unique GIDs (cached in `resolved`).
    const resolved = new Map<string, ResolvedMetaobject>()
    const ids = [...gidSet]
    const BATCH = 50
    const state = { denied: false }
    let hardFailures = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      hardFailures += await resolveMetaobjectBatch(ids.slice(i, i + BATCH), resolved, state)
    }

    // 3. Rewrite values in place. Single → resolved text, plus the metaobject's
    //    fields as extra metafields; list → resolved values joined with ", "
    //    (a list has no single set of fields to expose). Unresolved GIDs are
    //    kept (single) or skipped from the join (list) rather than dropped
    //    silently.
    let rewritten = 0
    let unresolved = 0
    let fieldMetafields = 0
    for (const p of products) {
      // Collected and appended after the loop — pushing onto p.metafields
      // while iterating it would walk into the new entries.
      const extra: ShopifyMetafield[] = []
      for (const mf of p.metafields) {
        if (isMetaobjectGid(mf.value)) {
          const mo = resolved.get(mf.value)
          if (mo) {
            mf.value = mo.value
            rewritten++
            extra.push(...metaobjectFieldMetafields(mf, mo))
          } else {
            unresolved++
          }
          continue
        }
        const gids = parseGidList(mf.value)
        if (!gids.length) continue
        const vals = gids.map((g) => resolved.get(g)?.value).filter((v): v is string => !!v)
        unresolved += gids.length - vals.length
        if (vals.length) {
          mf.value = vals.join(', ')
          rewritten++
        }
      }
      p.metafields.push(...extra)
      fieldMetafields += extra.length
    }
    console.log(
      `[shopify] metaobjects resolved — ${resolved.size}/${gidSet.size} unikke GID'er, ${rewritten} metafield-værdier omskrevet, ${fieldMetafields} metaobject-felter tilføjet${unresolved ? `, ${unresolved} uløste GID'er bevaret/sprunget` : ''}`
    )
    if (resolved.size < gidSet.size) {
      // Say it out loud — the symptom (a Shopify ID where a name belongs) is
      // otherwise a mystery to whoever looks at the feed.
      console.warn(
        `[shopify] ${gidSet.size - resolved.size} metaobject-GID'er kunne ikke oversættes` +
          `${hardFailures ? ` (${hardFailures} opslag fejlede)` : ''}` +
          `${state.denied ? ' — tokenet mangler scopet "read_metaobjects"' : ''}`
      )
    }

    return { total: gidSet.size, resolved: resolved.size, accessDenied: state.denied }
  }

  async function fetchProductsWithAllData(): Promise<ShopifyData> {
    const t0 = Date.now()

    const products = await fetchAllPages<ShopifyProduct>(
      `/products.json?limit=${PRODUCT_LIMIT}&status=active`,
      'products'
    )
    const tProducts = Date.now()
    console.log(`[shopify] products list (${products.length}): ${tProducts - t0}ms`)

    const productIds = products.map((p) => p.id)
    // Metafields and collections are independent enrichment passes — run in
    // parallel. Each is a sequential series of throttle-aware GraphQL calls;
    // shopifyGraphQL handles the bucket back-off if both series compete for it.
    const [productMetafieldsMap, productCollectionsMap] = await Promise.all([
      fetchProductMetafieldsBulk(productIds),
      fetchProductCollectionsBulk(productIds),
    ])
    const tEnrich = Date.now()
    const totalMfs = [...productMetafieldsMap.values()].reduce((s, l) => s + l.length, 0)
    const totalCols = [...productCollectionsMap.values()].reduce((s, l) => s + l.length, 0)
    console.log(
      `[shopify] enrichment parallel — metafields=${totalMfs}, collections=${totalCols}: ${tEnrich - tProducts}ms`
    )

    const enrichedProducts: ShopifyProduct[] = products.map((p) => ({
      ...p,
      metafields: productMetafieldsMap.get(p.id) ?? [],
      collections: productCollectionsMap.get(p.id) ?? [],
    }))

    // Resolve metaobject-reference metafields (region, grape, country, …) from
    // opaque GIDs to real values, in place. One cached pass; read-only.
    const tResolveStart = Date.now()
    const metaobjects = await resolveMetaobjectReferences(enrichedProducts)
    console.log(`[shopify] metaobject resolution: ${Date.now() - tResolveStart}ms`)

    console.log(`[shopify] fetchProductsWithAllData total: ${Date.now() - t0}ms`)
    return { products: enrichedProducts, metaobjects }
  }

  async function fetchMarkets(): Promise<ShopifyMarket[]> {
    const url = shopifyUrl('/graphql.json')

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: shopifyHeaders(),
        body: JSON.stringify({ query: MARKETS_QUERY }),
      })
    } catch (err) {
      console.error(`Shopify fetchMarkets: netværksfejl — ${err}`)
      return []
    }

    const rawText = await res.text()

    if (!res.ok) {
      console.error(`Shopify fetchMarkets: HTTP ${res.status} ${res.statusText} — ${rawText.slice(0, 500)}`)
      return []
    }

    let json: {
      data?: {
        shop?: { currencyCode?: string | null; primaryDomain?: { url?: string | null } | null } | null
        shopLocales?: ShopLocaleGql[] | null
        markets?: { nodes?: unknown[]; userErrors?: unknown[] }
        userErrors?: unknown[]
      }
      errors?: Array<{ message?: string; extensions?: unknown }>
      extensions?: unknown
    }
    try {
      json = JSON.parse(rawText)
    } catch (err) {
      console.error(`Shopify fetchMarkets: kunne ikke parse JSON — ${err}`)
      return []
    }

    if (json.errors?.length) {
      console.error(`Shopify fetchMarkets: GraphQL errors — ${JSON.stringify(json.errors)}`)
    }
    if (json.data?.markets?.userErrors?.length) {
      console.error(`Shopify fetchMarkets: markets.userErrors — ${JSON.stringify(json.data.markets.userErrors)}`)
    }
    if (json.data?.userErrors?.length) {
      console.error(`Shopify fetchMarkets: data.userErrors — ${JSON.stringify(json.data.userErrors)}`)
    }

    const nodes = json.data?.markets?.nodes
    if (!Array.isArray(nodes)) {
      console.error(`Shopify fetchMarkets: markets.nodes mangler/ikke array`)
      return []
    }

    type RawRootUrl = { locale: string; url: string }
    type RawRegion = { code?: string }
    type RawMarket = {
      id: string
      name: string
      handle: string
      status: string
      type: string
      // Null on stores that never configured per-market currency — the market
      // then runs on the shop's own currency.
      currencySettings: { baseCurrency: { currencyCode: string; currencyName: string } } | null
      webPresences: {
        nodes: Array<{
          rootUrls: RawRootUrl[]
          defaultLocale: ShopLocaleGql | null
          alternateLocales: ShopLocaleGql[] | null
        }>
      } | null
      regions: { nodes: RawRegion[] } | null
    }

    // Shop-level fallbacks for markets that carry no settings of their own.
    const shopCurrency = json.data?.shop?.currencyCode ?? ''
    const shopUrlRoot = json.data?.shop?.primaryDomain?.url ?? null
    const shopLocales = json.data?.shopLocales ?? []
    const shopPrimaryLocale = shopLocales.find((l) => l.primary) ?? shopLocales[0] ?? null

    return (nodes as RawMarket[]).map((m) => {
      const presence = m.webPresences?.nodes?.[0]
      const rootUrls = presence?.rootUrls ?? []
      // Pick the URL matching the web-presence's default locale; fall back to the
      // first available rootUrl so single-locale presences still work, and finally
      // to the shop's primary domain when the market has no web presence at all.
      const defaultLocaleCode = presence?.defaultLocale?.locale
      const matchedRootUrl =
        rootUrls.find((r) => r.locale === defaultLocaleCode)?.url ??
        rootUrls[0]?.url ??
        shopUrlRoot
      // Extract ISO country codes from MarketRegionCountry nodes — non-country
      // region types (e.g. "rest of world") return as empty objects and are
      // filtered out by the truthy check on `code`.
      const countryCodes = (m.regions?.nodes ?? [])
        .map((r) => r.code)
        .filter((c): c is string => typeof c === 'string' && c.length > 0)

      // Locales: a market without a web presence still publishes in the shop's
      // own locales, so offer those rather than an empty language picker.
      const defaultLocale = presence?.defaultLocale ?? shopPrimaryLocale
      const alternateLocales =
        presence?.alternateLocales ??
        shopLocales.filter((l) => l.locale !== defaultLocale?.locale)

      return {
        id: m.id,
        name: m.name,
        handle: m.handle,
        status: (m.status === 'ACTIVE' ? 'ACTIVE' : 'DRAFT') as 'ACTIVE' | 'DRAFT',
        type: m.type,
        currency: m.currencySettings?.baseCurrency?.currencyCode ?? shopCurrency,
        currencyName: m.currencySettings?.baseCurrency?.currencyName ?? null,
        defaultLocale,
        alternateLocales,
        marketUrl: matchedRootUrl,
        countryCodes,
      }
    })
  }

  // The scopes actually granted to this access token.
  //
  // Split out from probeShopifyAccess because that one also introspects the
  // Market schema — fine once, at connect time, but far too heavy for a page
  // that only wants to know whether a scope is missing.
  async function fetchGrantedScopes(): Promise<string[]> {
    const data = await shopifyGraphQL<{
      currentAppInstallation?: { accessScopes?: Array<{ handle: string }> }
    }>('{ currentAppInstallation { accessScopes { handle } } }')
    return (data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle)
  }

  // Probe to verify the access token works and to read which scopes have been granted.
  // Also introspects Market + MarketWebPresence so we can see the actual schema for
  // the API version Shopify is serving (relevant when our requested version is
  // auto-upgraded). Returns the raw JSON so the caller can log/inspect.
  async function probeShopifyAccess(): Promise<{
    httpStatus: number
    grantedScopesHeader: string | null
    apiVersionHeader: string | null
    rawBody: string
  }> {
    const url = shopifyUrl('/graphql.json')
    const query = `{
      shop { name myshopifyDomain primaryDomain { url } }
      currentAppInstallation { accessScopes { handle } }
      Market: __type(name: "Market") {
        name
        fields { name type { name kind ofType { name kind } } }
      }
      MarketWebPresence: __type(name: "MarketWebPresence") {
        name
        fields { name type { name kind ofType { name kind } } }
      }
    }`

    const res = await fetch(url, {
      method: 'POST',
      headers: shopifyHeaders(),
      body: JSON.stringify({ query }),
    })
    const body = await res.text()
    return {
      httpStatus: res.status,
      grantedScopesHeader: res.headers.get('x-shopify-api-granted-access-scopes'),
      apiVersionHeader: res.headers.get('x-shopify-api-version'),
      rawBody: body,
    }
  }

  // Fetch translations for a specific list of product IDs using the nodes query.
  // This avoids the mismatch between translatableResources cursor order and REST product order.
  async function fetchProductTranslations(
    locale: string,
    productIds: number[]
  ): Promise<Map<string, Record<string, string>>> {
    const map = new Map<string, Record<string, string>>()
    if (productIds.length === 0) return map

    const gids = productIds.map((id) => `gid://shopify/Product/${id}`)

    for (let i = 0; i < gids.length; i += 250) {
      const batch = gids.slice(i, i + 250)
      try {
        const data = await shopifyGraphQL<NodeTranslationsResponse>(
          `query GetTranslations($ids: [ID!]!, $locale: String!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                translations(locale: $locale) { key value outdated }
              }
            }
          }`,
          { ids: batch, locale }
        )

        for (const node of data.nodes) {
          if (!node) continue
          const productId = parseGid(node.id)
          if (!productId) continue
          const trans: Record<string, string> = {}
          for (const t of node.translations) {
            if (!t.outdated && t.value) trans[t.key] = t.value
          }
          if (Object.keys(trans).length > 0) map.set(String(productId), trans)
        }
      } catch (err) {
        console.error(`Shopify: oversættelsesbatch ${Math.floor(i / 250) + 1} fejlede — ${err}`)
      }
    }

    return map
  }

  // Fetch market-specific prices via Admin GraphQL `contextualPricing` on
  // ProductVariant. The context is keyed by ISO country code (CountryCode enum) —
  // not by Market GID, which is not a valid ContextualPricingContext field.
  // Shopify resolves the country to its corresponding market and returns the
  // converted price + currency for stores using automatic currency conversion.
  // `country` is forwarded as a typed GraphQL variable so it works dynamically
  // for any store / any market (DE, FR, DK, SE, …).
  async function fetchMarketPrices(
    products: ShopifyProduct[],
    country: string
  ): Promise<Map<string, Map<number, MarketVariantPrice>>> {
    const productMap = new Map<string, Map<number, MarketVariantPrice>>()
    if (products.length === 0) return productMap

    // Build flat list of variant GIDs and a reverse lookup variantId → productId
    // so we can rebuild the per-product structure from the flat node response.
    const variantToProduct = new Map<number, number>()
    const variantGids: string[] = []
    for (const p of products) {
      for (const v of p.variants) {
        variantToProduct.set(v.id, p.id)
        variantGids.push(`gid://shopify/ProductVariant/${v.id}`)
      }
    }

    for (let i = 0; i < variantGids.length; i += 250) {
      const batch = variantGids.slice(i, i + 250)
      try {
        const data = await shopifyGraphQL<NodeVariantPricesResponse>(
          `query GetVariantPrices($ids: [ID!]!, $country: CountryCode!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                contextualPricing(context: { country: $country }) {
                  price { amount currencyCode }
                  compareAtPrice { amount currencyCode }
                }
              }
            }
          }`,
          { ids: batch, country }
        )

        for (const node of data.nodes) {
          if (!node) continue
          const variantId = parseGid(node.id)
          if (!variantId) continue
          const productId = variantToProduct.get(variantId)
          if (!productId) continue

          let variantMap = productMap.get(String(productId))
          if (!variantMap) {
            variantMap = new Map<number, MarketVariantPrice>()
            productMap.set(String(productId), variantMap)
          }
          variantMap.set(variantId, {
            price: node.contextualPricing.price.amount,
            currency: node.contextualPricing.price.currencyCode,
            compare_at_price: node.contextualPricing.compareAtPrice?.amount ?? null,
          })
        }
      } catch (err) {
        console.error(`Shopify: markedsprisbatch ${Math.floor(i / 250) + 1} fejlede — ${err}`)
      }
    }

    return productMap
  }

  async function fetchProductsLocalized(
    locale: string,
    currency?: string,
    country?: string
  ): Promise<ShopifyData> {
    const t0 = Date.now()

    const { products, metaobjects } = await fetchProductsWithAllData()
    const tFetch = Date.now()

    const productIds = products.map((p) => p.id)

    // Translations and market prices both need data from the products fetch but
    // are independent of each other — run in parallel.
    const [translations, priceOverrides] = await Promise.all([
      locale && locale !== 'en'
        ? fetchProductTranslations(locale, productIds)
        : Promise.resolve(new Map<string, Record<string, string>>()),
      country
        ? fetchMarketPrices(products, country)
        : Promise.resolve(new Map<string, Map<number, MarketVariantPrice>>()),
    ])
    const tLocalize = Date.now()
    console.log(
      `[shopify] translations + market prices in parallel (locale=${locale}, country=${country ?? '-'}): ${tLocalize - tFetch}ms`
    )

    const finalProducts =
      translations.size === 0 && priceOverrides.size === 0
        ? products
        : products.map((p) => {
            const trans = translations.get(String(p.id))
            const variantPrices = priceOverrides.get(String(p.id))

            const updatedVariants = variantPrices
              ? p.variants.map((v) => {
                  const prices = variantPrices.get(v.id)
                  return prices
                    ? {
                        ...v,
                        price: prices.price,
                        compare_at_price: prices.compare_at_price,
                        currency: prices.currency,
                      }
                    : v
                })
              : p.variants

            return {
              ...p,
              title: trans?.['title'] ?? p.title,
              body_html: trans?.['body_html'] ?? p.body_html,
              variants: updatedVariants,
            }
          })

    console.log(`[shopify] fetchProductsLocalized total: ${Date.now() - t0}ms`)
    return { products: finalProducts, metaobjects }
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  /**
   * One page of orders updated at or after `updatedAtMin`, oldest first.
   *
   * Paging is the CALLER's job, not this function's, and deliberately so.
   * Every other fetcher here loops internally and returns everything, which is
   * safe when a failure halfway just means retrying a cheap read. Orders are
   * different: the data is perishable (migration 041), so the caller has to be
   * able to persist each page and advance its watermark before asking for the
   * next one. A function that swallowed 40 pages and then threw would lose all
   * 40.
   */
  async function fetchOrdersPage(
    updatedAtMin: string,
    cursor: string | null = null,
    pageSize = 10
  ): Promise<OrderFetchPage> {
    const money = (set: MoneySetGql | undefined): Money => ({
      shop: toAmount(set?.shopMoney?.amount),
      presentment: toAmount(set?.presentmentMoney?.amount),
    })

    const data = await shopifyGraphQL<OrdersResponse>(ORDERS_QUERY, {
      first: Math.max(1, Math.min(pageSize, 50)),
      after: cursor,
      // Shopify's search syntax. The quoting matters: an unquoted timestamp is
      // parsed as a bare token and silently matches nothing.
      q: `updated_at:>='${updatedAtMin}'`,
    })

    const orders: ShopifyOrder[] = data.orders.nodes.map((o) => ({
      orderRef: refOf(o.id),
      name: o.name ?? null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      processedAt: o.processedAt ?? null,
      cancelledAt: o.cancelledAt ?? null,
      // Shipping first: it is where the goods went, which is the market that
      // sold them. Billing is the fallback for digital orders with no shipping
      // address at all.
      countryCode:
        o.shippingAddress?.countryCodeV2 ?? o.billingAddress?.countryCodeV2 ?? null,
      shopCurrency: o.currencyCode ?? null,
      presentmentCurrency: o.presentmentCurrencyCode ?? null,
      totalPrice: money(o.totalPriceSet),
      subtotalPrice: money(o.subtotalPriceSet),
      totalTax: money(o.totalTaxSet),
      totalDiscounts: money(o.totalDiscountsSet),
      totalRefunded: money(o.totalRefundedSet),
      financialStatus: o.displayFinancialStatus ?? null,
      fulfillmentStatus: o.displayFulfillmentStatus ?? null,
      test: o.test === true,

      lineItems: o.lineItems.nodes.map((li) => ({
        lineItemRef: refOf(li.id),
        productRef: optionalRef(li.product?.id),
        variantRef: optionalRef(li.variant?.id),
        sku: li.sku ?? null,
        title: li.title ?? null,
        variantTitle: li.variantTitle ?? null,
        quantity: li.quantity ?? 0,
        price: money(li.originalUnitPriceSet),
        totalDiscount: money(li.totalDiscountSet),
      })),

      refunds: (o.refunds ?? []).map((r) => ({
        refundRef: refOf(r.id),
        createdAt: r.createdAt,
        processedAt: null,
        returnRef: optionalRef(r.return?.id),
        note: r.note ?? null,
        totalRefunded: money(r.totalRefundedSet),
        lineItems: r.refundLineItems.nodes.map((rli, i) => ({
          // RefundLineItem exposes no id of its own, so one is synthesised from
          // the refund and the line it refunds. Position is the tiebreaker for
          // the case Shopify permits but ecommerce rarely produces: the same
          // line refunded twice within one refund.
          refundLineRef: `${refOf(r.id)}:${optionalRef(rli.lineItem?.id) ?? 'x'}:${i}`,
          lineItemRef: optionalRef(rli.lineItem?.id),
          productRef: optionalRef(rli.lineItem?.product?.id),
          variantRef: optionalRef(rli.lineItem?.variant?.id),
          quantity: rli.quantity ?? 0,
          subtotal: money(rli.subtotalSet),
          totalTax: money(rli.totalTaxSet),
          restockType: rli.restockType ?? null,
        })),
      })),

      returns: (o.returns?.nodes ?? []).map((ret) => ({
        returnRef: refOf(ret.id),
        name: ret.name ?? null,
        status: ret.status ?? null,
        createdAt: ret.createdAt ?? null,
        closedAt: ret.closedAt ?? null,
        totalQuantity: ret.totalQuantity ?? 0,
        lineItems: ret.returnLineItems.nodes.map((rli, i) => ({
          returnLineRef: rli.id ? refOf(rli.id) : `${refOf(ret.id)}:${i}`,
          lineItemRef: optionalRef(rli.fulfillmentLineItem?.lineItem?.id),
          productRef: optionalRef(rli.fulfillmentLineItem?.lineItem?.product?.id),
          variantRef: optionalRef(rli.fulfillmentLineItem?.lineItem?.variant?.id),
          quantity: rli.quantity ?? 0,
          returnReason: rli.returnReason ?? null,
          returnReasonNote: rli.returnReasonNote ?? null,
        })),
      })),
    }))

    return {
      orders,
      hasNextPage: data.orders.pageInfo.hasNextPage,
      endCursor: data.orders.pageInfo.endCursor,
    }
  }

  return {
    fetchProductsWithAllData,
    fetchProductsLocalized,
    fetchMarkets,
    fetchGrantedScopes,
    fetchLocations,
    fetchVariantCostsBulk,
    fetchOrdersPage,
    probeShopifyAccess,
  }
}
