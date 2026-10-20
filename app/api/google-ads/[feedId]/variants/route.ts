import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getVariantPerformance, windowRange } from '@/lib/googleAdsAnalytics'
import { getReturnsForFeed } from '@/lib/returnsAnalytics'
import { getStockForFeed } from '@/lib/inventoryAnalytics'
import { errorResponse } from '@/lib/errors'

// GET — variant-level rows for one product, loaded when a row is expanded.
//
// On demand rather than shipped with the page: variant rows outnumber products
// several times over, and on a large catalogue sending them all up front would
// dwarf the payload for detail almost nobody opens.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  try {
    const { feedId } = await params

    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const feed = await getOwnedFeed(user.id, feedId)
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const url = new URL(req.url)
    const productRef = url.searchParams.get('product')
    const days = Number(url.searchParams.get('days') ?? 30)

    if (!productRef) {
      return NextResponse.json({ error: 'product is required' }, { status: 400 })
    }

    // The metric definition travels with the request: the page can be showing a
    // different action than the feed's saved default, and expanded rows must
    // agree with the parent row they came from.
    // Repeated params (?roas=A&roas=B) rather than a delimiter, because action
    // names are free text and may contain whatever separator we picked.
    const db = adminDb()
    const variants = await getVariantPerformance(db, feedId, days, productRef, {
      roas: url.searchParams.getAll('roas').filter(Boolean),
      poas: url.searchParams.getAll('poas').filter(Boolean),
    })

    // Returns ride along rather than being fetched separately by the client:
    // the drill-down must measure the same market and the same cohort as the
    // product row it opened from, and getReturnsForFeed is what guarantees it.
    //
    // Sent as a lookup keyed by variant_ref, mirroring how the product table
    // receives its own. A variant missing from it has an unknown return rate,
    // which is not a rate of zero.
    const { from, to } = windowRange(days)
    const returns = await getReturnsForFeed(db, feedId, { from, to })

    const returnsByVariant: Record<
      string,
      { returnRate: number | null; refundedInWindow: number; sampleUnits: number }
    > = {}
    for (const v of variants) {
      if (!v.variantRef) continue
      const r = returns.byVariant.get(v.variantRef)
      if (!r) continue
      returnsByVariant[v.variantRef] = {
        returnRate: r.returnRate,
        refundedInWindow: r.refundedInWindow,
        sampleUnits: r.sampleUnits,
      }
    }

    // ── Stock for EVERY variant of this product, not just the ones with ads ──
    //
    // Deliberately keyed off the catalogue rather than off `variants` above.
    // The performance rows only contain variants Google reported on, and a
    // variant that is out of stock has usually stopped being served — Merchant
    // Center drops an unavailable offer — so the ones the operator most wants
    // named are exactly the ones missing from the ads data. Sending the full
    // set lets the client annotate the rows it has AND name the ones it does
    // not, instead of showing "2 of 5 out of stock" above a list where every
    // listed variant is in stock.
    const stock = await getStockForFeed(db, feedId, { productRef })

    const stockByVariant: Record<
      string,
      {
        title: string | null
        sku: string | null
        sellable: boolean
        quantity: number | null
        daysOfStock: number | null
      }
    > = {}
    for (const [ref, s] of stock.byVariant) {
      if (s.productRef !== productRef) continue
      stockByVariant[ref] = {
        title: s.title,
        sku: s.sku,
        sellable: s.sellable,
        quantity: s.quantity,
        daysOfStock: s.daysOfStock,
      }
    }

    return NextResponse.json({ variants, returns: returnsByVariant, stock: stockByVariant })
  } catch (err) {
    return errorResponse(err, 'GET /api/google-ads/[feedId]/variants')
  }
}
