import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { logActivity } from '@/lib/activity'

type ShopSettingsBody = {
  feed_id: string
  selected_market_id?: string | null
  selected_locale?: string
  selected_country?: string
  currency?: string
  market_url?: string | null
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const feedId = url.searchParams.get('feedId')
  if (!feedId) return NextResponse.json({ error: 'feedId is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return NextResponse.json({ error: 'Feed not found' }, { status: 404 })

  const db = adminDb()
  const { data } = await db
    .from('shop_settings')
    .select('selected_market_id, selected_locale, selected_country, currency, market_url')
    .eq('feed_id', feedId)
    .maybeSingle()

  // The project's storefront domain, so the mapping preview can build product
  // links the same way the generated feed does when the selected market has no
  // web presence of its own (see resolveFeedBaseUrl in lib/feedGenerator.ts).
  const { data: project } = owned.project_id
    ? await db.from('projects').select('primary_domain').eq('id', owned.project_id).maybeSingle()
    : { data: null }

  return NextResponse.json({
    settings: data ?? null,
    primaryDomain: (project?.primary_domain as string | null) ?? null,
  })
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json()) as ShopSettingsBody
  if (!body.feed_id) return NextResponse.json({ error: 'feed_id is missing' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, body.feed_id)
  if (!owned) return NextResponse.json({ error: 'Feed not found' }, { status: 404 })

  const db = adminDb()
  const { data: prev } = await db
    .from('shop_settings')
    .select('selected_country, selected_locale')
    .eq('feed_id', body.feed_id)
    .maybeSingle()
  const { error } = await db.from('shop_settings').upsert(
    {
      feed_id: body.feed_id,
      user_id: user.id,
      selected_market_id: body.selected_market_id ?? null,
      selected_locale: body.selected_locale ?? 'en',
      selected_country: body.selected_country ?? 'US',
      currency: body.currency ?? 'USD',
      market_url: body.market_url ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'feed_id' }
  )

  if (error) return errorResponse(error, 'POST /api/settings')

  const was = prev ? `${prev.selected_country ?? '?'} · ${prev.selected_locale ?? '?'}` : null
  const now = `${body.selected_country ?? 'US'} · ${body.selected_locale ?? 'en'}`
  if (was !== now) {
    await logActivity(db, { user, feedId: body.feed_id, area: 'Settings', action: 'Market and language changed', before: was, after: now })
  }
  return NextResponse.json({ ok: true })
}
