import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { createShopifyClient } from '@/lib/shopify'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import { encryptToken } from '@/lib/crypto'
import { missingScopes } from '@/lib/shopifyScopes'
import { enforceRateLimit } from '@/lib/rateLimit'
import { errorResponse } from '@/lib/errors'

// Strip protocol and any path so we store the bare *.myshopify.com domain that
// lib/shopify.ts expects (it builds `https://${shopUrl}/admin/...`).
function normalizeShopUrl(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
}

type ProbeBody = {
  data?: {
    shop?: {
      name?: string
      myshopifyDomain?: string
      primaryDomain?: { url?: string } | null
    } | null
    currentAppInstallation?: { accessScopes?: Array<{ handle: string }> }
  }
  errors?: Array<{ message?: string }>
}

// POST — configure (or rotate) a project's Shopify connection.
// Probes the supplied credentials BEFORE persisting; only stores the token
// (encrypted) when the probe authenticates. The plaintext token never leaves
// this server-side handler.
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
    shop_url?: string
    access_token?: string
  }
  const shopUrl = normalizeShopUrl(body.shop_url ?? '')
  const accessToken = (body.access_token ?? '').trim()

  if (!shopUrl) return NextResponse.json({ error: 'shop_url er påkrævet' }, { status: 400 })
  if (!accessToken) return NextResponse.json({ error: 'access_token er påkrævet' }, { status: 400 })

  // ── Probe before persisting ────────────────────────────────────────────────
  const shopify = createShopifyClient({ shopUrl, accessToken })

  let probe
  try {
    probe = await shopify.probeShopifyAccess()
  } catch (err) {
    return NextResponse.json(
      {
        error: `Kunne ikke nå Shopify — tjek shop-URL'en. (${err instanceof Error ? err.message : 'netværksfejl'})`,
      },
      { status: 400 }
    )
  }

  let parsed: ProbeBody = {}
  try {
    parsed = JSON.parse(probe.rawBody) as ProbeBody
  } catch {
    // fall through — handled by the success check below
  }

  const authenticated = probe.httpStatus === 200 && !!parsed.data?.shop && !parsed.errors?.length

  if (!authenticated) {
    const detail =
      parsed.errors?.[0]?.message ??
      (probe.httpStatus === 401 || probe.httpStatus === 403
        ? 'access token afvist'
        : `HTTP ${probe.httpStatus}`)
    return NextResponse.json(
      { error: `Forbindelsen kunne ikke verificeres — ${detail}. Intet blev gemt.` },
      { status: 400 }
    )
  }

  const scopes = parsed.data?.currentAppInstallation?.accessScopes?.map((s) => s.handle) ?? []
  const missing = missingScopes(scopes)

  // Customer-facing storefront root (e.g. "https://www.vinnu.dk"). Product links
  // fall back to this when the selected market has no Shopify Markets web
  // presence of its own — see migration 030. Trailing slash stripped so callers
  // can append paths without doubling up.
  const primaryDomain =
    parsed.data?.shop?.primaryDomain?.url?.trim().replace(/\/+$/, '') || null

  // ── Persist (encrypted) on success ──────────────────────────────────────────
  const enc = encryptToken(accessToken)
  const now = new Date().toISOString()

  const db = adminDb()
  const { error: updateErr } = await db
    .from('projects')
    .update({
      shop_url: shopUrl,
      primary_domain: primaryDomain,
      access_token_ciphertext: enc.ciphertext,
      access_token_iv: enc.iv,
      access_token_tag: enc.tag,
      connection_status: 'connected',
      last_verified_at: now,
      updated_at: now,
    })
    .eq('id', projectId)
    .eq('user_id', user.id)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    connection_status: 'connected',
    last_verified_at: now,
    shop: parsed.data?.shop?.myshopifyDomain ?? parsed.data?.shop?.name ?? shopUrl,
    // Non-blocking: the token authenticates, but some capabilities are degraded
    // without these. The UI surfaces them as warnings rather than refusing the
    // connection — a feed of plain product fields works fine without any of them.
    missingScopes: missing,
    grantedScopes: scopes,
  })
}

// GET — re-read the granted scopes for an already-connected project.
//
// The scopes are NOT stored on the project row, so the only way to know them
// later is to ask Shopify again. That is deliberate: a stored copy goes stale
// the moment someone edits the app in Shopify Admin, and a stale "all good"
// is worse than no answer. One small query, on a single-project page.
export async function GET(
  _req: Request,
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

  try {
    // Reaches an external API, so it goes through the shared limiter like every
    // other Shopify-touching route.
    await enforceRateLimit(user.id, 'shopify_scope_check')
  } catch (err) {
    return errorResponse(err, 'GET /api/projects/[projectId]/connect')
  }

  try {
    const shopify = await createShopifyClientForProject(adminDb(), projectId)
    const granted = await shopify.fetchGrantedScopes()
    return NextResponse.json({ checked: true, missingScopes: missingScopes(granted) })
  } catch {
    // No connection yet, an undecryptable token, or Shopify being unreachable.
    // This is an advisory check — it must never turn into a page-level error.
    return NextResponse.json({ checked: false, missingScopes: [] })
  }
}
