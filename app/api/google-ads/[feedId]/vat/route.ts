import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getFeedSettings, saveFeedSettings } from '@/lib/feedGoogleAds'
import { errorResponse } from '@/lib/errors'

// POST — the VAT bases this feed reads its numbers on.
//
// Its own route rather than a field on /settings: that one is the setup form and
// writes customer_id from its body, so a request that only meant to say "25%"
// would null the account. Small, separate, and unable to touch anything else.
//
// TWO INDEPENDENT QUESTIONS, ONE RATE:
//   prices_include_vat             — do Shopify's prices carry VAT (migration 040)
//   conversion_value_includes_vat  — does Google's reported value (migration 043)
// They are genuinely unrelated — a shop can store net prices and still report a
// gross order total — so neither is derived from the other, and the rate they
// share survives as long as EITHER of them needs it.
//
// AN ABSENT KEY MEANS "LEAVE IT ALONE", not "set it to null". The same hazard
// this route was split off to avoid applies within it: the prices editor and the
// conversion-value editor each send one question, and either would otherwise
// wipe the other's answer on save.
export async function POST(req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  try {
    const { feedId } = await params

    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const feed = await getOwnedFeed(user.id, feedId)
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const body = (await req.json().catch(() => ({}))) as {
      pricesIncludeVat?: boolean | null
      conversionValueIncludesVat?: boolean | null
      vatRate?: number | null
    }

    const db = adminDb()
    const current = await getFeedSettings(db, feedId)

    const tri = (v: boolean | null | undefined): boolean | null =>
      v === null || v === undefined ? null : !!v

    // Merge before deciding anything: whether the rate is still needed depends
    // on BOTH answers, only one of which this request may carry.
    const prices =
      'pricesIncludeVat' in body ? tri(body.pricesIncludeVat) : (current?.prices_include_vat ?? null)
    const conversionValue =
      'conversionValueIncludesVat' in body
        ? tri(body.conversionValueIncludesVat)
        : (current?.conversion_value_includes_vat ?? null)

    const needsRate = prices === true || conversionValue === true
    const submitted = 'vatRate' in body ? body.vatRate : (current?.vat_rate ?? null)

    let rate: number | null = null
    if (needsRate) {
      const n = Number(submitted)
      if (!Number.isFinite(n) || n < 0 || n >= 100) {
        return NextResponse.json(
          { error: 'Enter a VAT rate between 0 and 99 — 25 for Denmark.' },
          { status: 400 }
        )
      }
      // Two decimals, matching the column. Rates like 21.5 exist; 25.0000001
      // does not, and would only ever be a slip of the keyboard.
      rate = Math.round(n * 100) / 100
    }

    const settings = await saveFeedSettings(db, feedId, {
      prices_include_vat: prices,
      conversion_value_includes_vat: conversionValue,
      // Cleared only when NEITHER basis carries VAT, so a stale rate can never
      // be read back as though it still applied — while a rate the other
      // question still depends on survives an edit to this one.
      vat_rate: rate,
    })

    return NextResponse.json({ ok: true, settings })
  } catch (err) {
    return errorResponse(err, 'POST /api/google-ads/[feedId]/vat')
  }
}
