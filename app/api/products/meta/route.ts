import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'

const ALLOWED_PAGE_SIZES = [20, 25, 50, 100, 200] as const
const DEFAULT_PAGE_SIZE = 25

// PostgREST default cap. Used when paging through products to collect unique
// vendor / product_type values (no DISTINCT in PostgREST without an RPC).
const FACET_PAGE_SIZE = 1000

function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, '')
}

// Returns total + totalPages (search/filter aware) plus stable facet lists
// (vendors and product_types for the whole feed, not just the current page).
// Used as LAG 2 by the products page so the topbar count, pagination and
// filter dropdowns can render asynchronously without holding back LAG 1.
export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) return Response.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return Response.json({ error: 'Feed not found' }, { status: 404 })

  const pageSizeRaw = parseInt(url.searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10)
  const pageSize = (ALLOWED_PAGE_SIZES as readonly number[]).includes(pageSizeRaw)
    ? pageSizeRaw
    : DEFAULT_PAGE_SIZE

  const searchRaw = (url.searchParams.get('search') ?? '').trim()
  const search = searchRaw.replace(/[,()*]/g, '')

  const fVendor = (url.searchParams.get('vendor') ?? '').trim()
  const fProductType = (url.searchParams.get('product_type') ?? '').trim()
  const fStatus = (url.searchParams.get('status') ?? '').trim()
  const fInStock = (url.searchParams.get('in_stock') ?? '').trim()
  const fTags = (url.searchParams.get('tags') ?? '').trim()
  const fSku = (url.searchParams.get('sku') ?? '').trim()
  const fTitle = (url.searchParams.get('title') ?? '').trim()
  const fHandle = (url.searchParams.get('handle') ?? '').trim()
  const fPriceGt = (url.searchParams.get('price_gt') ?? '').trim()
  const fPriceLt = (url.searchParams.get('price_lt') ?? '').trim()

  try {
    const db = adminDb()

    let countQuery = db
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('feed_id', feedId)

    if (search) {
      const pattern = `*${search}*`
      countQuery = countQuery.or(
        `title.ilike.${pattern},vendor.ilike.${pattern},handle.ilike.${pattern},tags.ilike.${pattern}`
      )
    }
    if (fVendor) countQuery = countQuery.eq('vendor', fVendor)
    if (fProductType) countQuery = countQuery.eq('product_type', fProductType)
    if (fStatus === 'active') countQuery = countQuery.eq('status', 'active')
    else if (fStatus === 'inactive') countQuery = countQuery.neq('status', 'active')
    if (fInStock === 'true') {
      countQuery = countQuery.filter('variants->0->>inventory_quantity::int', 'gt', 0)
    } else if (fInStock === 'false') {
      countQuery = countQuery.filter('variants->0->>inventory_quantity::int', 'lte', 0)
    }
    if (fTags) countQuery = countQuery.ilike('tags', `%${escapeIlike(fTags)}%`)
    if (fTitle) countQuery = countQuery.ilike('title', `%${escapeIlike(fTitle)}%`)
    if (fHandle) countQuery = countQuery.ilike('handle', `%${escapeIlike(fHandle)}%`)
    if (fSku) {
      countQuery = countQuery.filter('variants->0->>sku', 'ilike', `%${escapeIlike(fSku)}%`)
    }
    if (fPriceGt) {
      const n = parseFloat(fPriceGt)
      if (!Number.isNaN(n)) countQuery = countQuery.filter('variants->0->>price::numeric', 'gt', n)
    }
    if (fPriceLt) {
      const n = parseFloat(fPriceLt)
      if (!Number.isNaN(n)) countQuery = countQuery.filter('variants->0->>price::numeric', 'lt', n)
    }

    // Facets are scoped to the feed (not the active search), so the dropdowns
    // stay stable while the user types. Page through to bypass the 1000-row cap.
    async function fetchFacets(): Promise<{ vendors: string[]; productTypes: string[] }> {
      const vendors = new Set<string>()
      const productTypes = new Set<string>()
      let from = 0
      while (true) {
        const { data, error } = await db
          .from('products')
          .select('vendor, product_type')
          .eq('feed_id', feedId)
          .range(from, from + FACET_PAGE_SIZE - 1)
        if (error || !data || data.length === 0) break
        for (const row of data as { vendor: string | null; product_type: string | null }[]) {
          if (row.vendor) vendors.add(row.vendor)
          if (row.product_type) productTypes.add(row.product_type)
        }
        if (data.length < FACET_PAGE_SIZE) break
        from += FACET_PAGE_SIZE
      }
      return {
        vendors: [...vendors].sort(),
        productTypes: [...productTypes].sort(),
      }
    }

    const [{ count, error: countErr }, facets] = await Promise.all([
      countQuery,
      fetchFacets(),
    ])
    if (countErr) throw new Error(countErr.message)

    const total = count ?? 0
    const totalPages = Math.max(1, Math.ceil(total / pageSize))

    return Response.json({
      total,
      totalPages,
      vendors: facets.vendors,
      productTypes: facets.productTypes,
    })
  } catch (err) {
    return errorResponse(err, 'GET /api/products/meta')
  }
}
