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

  type MetaobjectNodesResponse = {
    nodes: Array<{
      id: string
      displayName: string | null
      fields: Array<{ key: string; value: string | null }>
    } | null>
  }

  // Looks up a batch of Metaobject GIDs, writing id → display value into `out`.
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
    out: Map<string, string>,
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
              fields { key value }
            }
          }
        }`,
        { ids }
      )
      for (const node of data.nodes) {
        if (!node) continue
        const value = pickMetaobjectValue(node)
        if (value) out.set(node.id, value)
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
  // products share the same region/grape/country. READ-ONLY: a single GraphQL
  // `query`, no mutations. Unresolvable GIDs are left as-is so no data is
  // silently dropped.
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
    const resolved = new Map<string, string>()
    const ids = [...gidSet]
    const BATCH = 50
    const state = { denied: false }
    let hardFailures = 0
    for (let i = 0; i < ids.length; i += BATCH) {
      hardFailures += await resolveMetaobjectBatch(ids.slice(i, i + BATCH), resolved, state)
    }

    // 3. Rewrite values in place. Single → resolved text; list → resolved
    //    values joined with ", ". Unresolved GIDs are kept (single) or skipped
    //    from the join (list) rather than dropped silently.
    let rewritten = 0
    let unresolved = 0
    for (const p of products) {
      for (const mf of p.metafields) {
        if (isMetaobjectGid(mf.value)) {
          const v = resolved.get(mf.value)
          if (v) {
            mf.value = v
            rewritten++
          } else {
            unresolved++
          }
          continue
        }
        const gids = parseGidList(mf.value)
        if (!gids.length) continue
        const vals = gids.map((g) => resolved.get(g)).filter((v): v is string => !!v)
        unresolved += gids.length - vals.length
        if (vals.length) {
          mf.value = vals.join(', ')
          rewritten++
        }
      }
    }
    console.log(
      `[shopify] metaobjects resolved — ${resolved.size}/${gidSet.size} unikke GID'er, ${rewritten} metafield-værdier omskrevet${unresolved ? `, ${unresolved} uløste GID'er bevaret/sprunget` : ''}`
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

  return {
    fetchProductsWithAllData,
    fetchProductsLocalized,
    fetchMarkets,
    fetchGrantedScopes,
    probeShopifyAccess,
  }
}
