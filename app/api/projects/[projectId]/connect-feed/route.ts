import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { logActivity } from '@/lib/activity'
import { fetchFeedUrlProducts, type FeedAuth } from '@/lib/feedUrlSource'
import { decryptFeedAuth, encryptFeedAuth, NO_FEED_AUTH, type FeedAuthColumns } from '@/lib/feedAuth'
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
//
// Optional HTTP Basic Auth login (auth_username / auth_password) for protected
// feeds, stored encrypted (lib/feedAuth.ts) and never returned. With both left
// empty and keep_auth set, the stored login is kept — but only when the new URL
// has the same origin as the old one, so a login is never re-pointed at a
// different host. Otherwise an empty login clears it.
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

  const body = (await req.json().catch(() => ({}))) as {
    feed_url?: string
    auth_username?: string
    auth_password?: string
    keep_auth?: boolean
  }
  const feedUrl = (body.feed_url ?? '').trim()
  if (!feedUrl) return NextResponse.json({ error: 'feed_url is required' }, { status: 400 })

  const username = (body.auth_username ?? '').trim()
  const password = body.auth_password ?? ''
  if (!username && password) {
    return NextResponse.json({ error: 'Enter a username for the password' }, { status: 400 })
  }
  if (username.includes(':')) {
    return NextResponse.json({ error: 'The username cannot contain ":"' }, { status: 400 })
  }

  try {
    // The probe downloads the whole feed — same cost guard as a sync.
    await enforceRateLimit(user.id, 'shopify_sync')

    let auth: FeedAuth | null = username ? { username, password } : null
    let authColumns: FeedAuthColumns = auth ? encryptFeedAuth(auth) : NO_FEED_AUTH
    if (!auth && body.keep_auth) {
      const { data: current } = await adminDb()
        .from('projects')
        .select('source_type, feed_url, feed_auth_ciphertext, feed_auth_iv, feed_auth_tag')
        .eq('id', projectId)
        .maybeSingle<{ source_type: string | null; feed_url: string | null } & FeedAuthColumns>()
      const stored = current?.source_type === 'feed_url' ? decryptFeedAuth(current) : null
      if (stored && current?.feed_url && sameOrigin(current.feed_url, feedUrl)) {
        auth = stored
        authColumns = {
          feed_auth_ciphertext: current.feed_auth_ciphertext,
          feed_auth_iv: current.feed_auth_iv,
          feed_auth_tag: current.feed_auth_tag,
        }
      }
    }

    const probe = await fetchFeedUrlProducts(feedUrl, auth)

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
        ...authColumns,
        connection_status: 'connected',
        last_verified_at: now,
        updated_at: now,
      })
      .eq('id', projectId)
    if (updateErr) return errorResponse(updateErr, 'POST /api/projects/[projectId]/connect-feed update')

    // Host only: a feed URL can carry an access key in its query string.
    const host = (u: string | null) => {
      try {
        return u ? new URL(u).host : null
      } catch {
        return null
      }
    }
    await logActivity(adminDb(), {
      user,
      projectId,
      accountId: owned.account_id,
      area: 'Connections',
      action: owned.source_type === 'feed_url' ? 'Feed URL changed' : 'Feed URL connected',
      before: owned.source_type === 'feed_url' ? host(owned.feed_url) : owned.shop_url,
      after: host(feedUrl),
    })

    return NextResponse.json({
      ok: true,
      connection_status: 'connected',
      last_verified_at: now,
      feed_url: feedUrl,
      productCount: probe.products.length,
      hasAuth: auth !== null,
    })
  } catch (err) {
    return errorResponse(err, 'POST /api/projects/[projectId]/connect-feed')
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}
