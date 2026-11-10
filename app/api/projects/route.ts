import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, type ProjectRow } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// GET — list the user's projects with feed counts + connection status.
// Never returns the encrypted token columns.
export async function GET() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = adminDb()

  const { data: projects, error } = await db
    .from('projects')
    .select('id, name, description, shop_url, source_type, feed_url, primary_domain, connection_status, last_verified_at, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  if (error) return errorResponse(error, 'GET /api/projects')

  const projectIds = (projects ?? []).map((p) => p.id)

  // Per-project feed count via head:true so PostgREST returns just a count
  // header (same pattern as /api/feeds). allSettled so one failure doesn't
  // drop the whole list.
  const feedCount = new Map<string, number>()
  if (projectIds.length > 0) {
    const results = await Promise.allSettled(
      projectIds.map(
        async (id) =>
          [
            id,
            await db
              .from('feeds')
              .select('id', { count: 'exact', head: true })
              .eq('project_id', id),
          ] as const
      )
    )
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const [id, res] = r.value
        feedCount.set(id, res.count ?? 0)
      } else {
        console.error('[/api/projects] feed count failed for one project:', r.reason)
      }
    }
  }

  const enriched = (projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    // The list shows one "where products come from" label: the Shopify admin
    // domain, or for feed-URL projects the storefront host the feed points at.
    shopUrl: p.source_type === 'feed_url' ? hostOf(p.primary_domain ?? p.feed_url) : p.shop_url,
    sourceType: p.source_type ?? 'shopify',
    connectionStatus: p.connection_status,
    lastVerifiedAt: p.last_verified_at,
    created_at: p.created_at,
    updated_at: p.updated_at,
    feedCount: feedCount.get(p.id) ?? 0,
  }))

  return NextResponse.json({ projects: enriched })
}

// POST — create a project. The Shopify connection is configured separately via
// POST /api/projects/[projectId]/connect, so a new project starts 'unverified'
// with no token.
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { name?: string; description?: string }
  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const db = adminDb()
  const { data, error } = await db
    .from('projects')
    .insert({
      user_id: user.id,
      name,
      description: body.description?.trim() || null,
    })
    .select('id, name, description, shop_url, connection_status, last_verified_at, created_at, updated_at')
    .single<ProjectRow>()

  if (error) return errorResponse(error, 'POST /api/projects')

  return NextResponse.json({ project: data })
}
