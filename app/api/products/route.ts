import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { toShopifyData, type SupabaseProduct } from '@/lib/sync'
import { feedView, type FeedViewItem } from '@/lib/feedGenerator'

const ALLOWED_PAGE_SIZES = [20, 25, 50, 100, 200] as const
const DEFAULT_PAGE_SIZE = 25

// Strip Postgres ilike wildcard chars from user input so they can't accidentally
// (or intentionally) inject wildcards into the LIKE pattern we wrap them in.
function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, '')
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) return Response.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return Response.json({ error: 'Feed not found' }, { status: 404 })

  // Pagination params — clamp to safe values so the URL can't request 100k/page.
  const pageRaw = parseInt(url.searchParams.get('page') ?? '1', 10)
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1

  const pageSizeRaw = parseInt(url.searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10)
  const pageSize = (ALLOWED_PAGE_SIZES as readonly number[]).includes(pageSizeRaw)
    ? pageSizeRaw
    : DEFAULT_PAGE_SIZE

  // Free-text search across title/vendor/handle/tags. Strip characters that
  // break PostgREST's .or() DSL (commas, parens, asterisks); the input is
  // otherwise free-form and case-insensitive via ilike.
  const searchRaw = (url.searchParams.get('search') ?? '').trim()
  const search = searchRaw.replace(/[,()*]/g, '')

  // skipCount=1 omits the count: 'exact' header so PostgREST returns rows
  // without scanning the whole filtered set for an exact total. Used by the
  // products page LAG 1 fetch — total/totalPages come from /api/products/meta
  // instead. When skipCount is on, the response carries total: null.
  const skipCount = url.searchParams.get('skipCount') === '1'

  // feedView=1 adds, per product, whether it is in the feed (and why not) and
  // its mapped feed values — what the Products page shows. Off by default:
  // resolving mappings costs more than reading rows.
  const withFeedView = url.searchParams.get('feedView') === '1'

  // Sort order. Price/stock live inside the variants JSONB and would sort as
  // text, so only name and age are offered.
  const sort = url.searchParams.get('sort') ?? ''

  // Discrete filter params used by the field-preview sidebar. Each one is
  // optional; missing or empty params are no-ops. All filters AND together.
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
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let query = db
      .from('products')
      .select(
        '*, metafields:product_metafields(*)',
        skipCount ? undefined : { count: 'exact' }
      )
      .eq('feed_id', feedId)

    if (sort === 'title_asc') query = query.order('title', { ascending: true })
    else if (sort === 'title_desc') query = query.order('title', { ascending: false })
    else if (sort === 'newest') query = query.order('created_at', { ascending: false })
    else query = query.order('created_at', { ascending: true })
    // id breaks ties so offset pages never repeat or skip rows.
    query = query.order('id', { ascending: true }).range(from, to)

    if (search) {
      const pattern = `*${search}*`
      query = query.or(
        `title.ilike.${pattern},vendor.ilike.${pattern},handle.ilike.${pattern},tags.ilike.${pattern}`
      )
    }

    if (fVendor) query = query.eq('vendor', fVendor)
    if (fProductType) query = query.eq('product_type', fProductType)

    // Status: "active" exact-match; "inactive" = anything that isn't active.
    if (fStatus === 'active') query = query.eq('status', 'active')
    else if (fStatus === 'inactive') query = query.neq('status', 'active')

    // Inventory lives inside the variants JSONB array. Postgres jsonb path +
    // ::int cast lets us compare numerically against the first variant's
    // inventory_quantity.
    if (fInStock === 'true') {
      query = query.filter('variants->0->>inventory_quantity::int', 'gt', 0)
    } else if (fInStock === 'false') {
      query = query.filter('variants->0->>inventory_quantity::int', 'lte', 0)
    }

    if (fTags) query = query.ilike('tags', `%${escapeIlike(fTags)}%`)
    if (fTitle) query = query.ilike('title', `%${escapeIlike(fTitle)}%`)
    if (fHandle) query = query.ilike('handle', `%${escapeIlike(fHandle)}%`)
    if (fSku) {
      query = query.filter(
        'variants->0->>sku',
        'ilike',
        `%${escapeIlike(fSku)}%`
      )
    }

    if (fPriceGt) {
      const n = parseFloat(fPriceGt)
      if (!Number.isNaN(n)) query = query.filter('variants->0->>price::numeric', 'gt', n)
    }
    if (fPriceLt) {
      const n = parseFloat(fPriceLt)
      if (!Number.isNaN(n)) query = query.filter('variants->0->>price::numeric', 'lt', n)
    }

    const { data, error, count } = await query
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as SupabaseProduct[]
    const products = toShopifyData(rows).products
    let feed: Record<string, FeedViewItem> | undefined
    if (withFeedView) feed = Object.fromEntries(await feedView(feedId, rows))
    const total = skipCount ? null : (count ?? 0)
    const totalPages = total === null ? null : Math.max(1, Math.ceil(total / pageSize))

    return Response.json({
      products,
      // Keyed by source_id (products.shopify_id). Only with feedView=1.
      ...(feed ? { feed } : {}),
      total,
      page,
      pageSize,
      totalPages,
    })
  } catch (err) {
    return errorResponse(err, 'GET /api/products')
  }
}
