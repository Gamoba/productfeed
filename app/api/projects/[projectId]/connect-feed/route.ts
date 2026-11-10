import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { fetchFeedUrlProducts } from '@/lib/feedUrlSource'
import { errorResponse } from '@/lib/errors'
import { enforceRateLimit } from '@/lib/rateLimit'

// The probe downloads and parses the whole source feed.
export const maxDuration = 300

// POST — point a project at a public product feed URL instead of Shopify.
//
// Probes the URL BEFORE persisting: it must download and contain at least one
// product, so a typo or an HTML page is rejected without changing anything.
// Switching a project to a feed URL clears any stored Shopify credentials —
// a project has exactly one source, and an unused token shouldn't linger.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const owned = await getOwnedProject(user.id, projectId)
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { feed_url?: string }
  const feedUrl = (body.feed_url ?? '').trim()
  if (!feedUrl) return NextResponse.json({ error: 'feed_url er påkrævet' }, { status: 400 })

  try {
    // The probe downloads the whole feed — same cost guard as a sync.
    await enforceRateLimit(user.id, 'shopify_sync')
    const probe = await fetchFeedUrlProducts(feedUrl)

    // Storefront root from the first product link — shown in the UI, and the
    // same fallback base the generator uses for products without a link.
    let primaryDomain: string | null = null
    const firstLink = probe.products.find((p) => p.link)?.link
    if (firstLink) {
      try {
        primaryDomain = new URL(firstLink).origin
      } catch {
        primaryDomain = null
      }
    }

    const now = new Date().toISOString()
    const { error: updateErr } = await adminDb()
      .from('projects')
      .update({
        source_type: 'feed_url',
        feed_url: feedUrl,
        primary_domain: primaryDomain,
        shop_url: null,
        access_token_ciphertext: null,
        access_token_iv: null,
        access_token_tag: null,
        connection_status: 'connected',
        last_verified_at: now,
        updated_at: now,
      })
      .eq('id', projectId)
      .eq('user_id', user.id)
    if (updateErr) return errorResponse(updateErr, 'POST /api/projects/[projectId]/connect-feed update')

    return NextResponse.json({
      ok: true,
      connection_status: 'connected',
      last_verified_at: now,
      feed_url: feedUrl,
      productCount: probe.products.length,
    })
  } catch (err) {
    return errorResponse(err, 'POST /api/projects/[projectId]/connect-feed')
  }
}
