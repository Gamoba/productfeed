import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject, purgeFeedProducts } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'

// DELETE — remove a project. ON DELETE CASCADE on feeds.project_id (migration
// 019) removes the project's feeds, and from there the existing feed_id
// cascades (009) remove mappings, filters, products, metafields and cache.
export async function DELETE(
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

  const db = adminDb()
  // Each feed's products first, in batches — one cascading delete of a large
  // catalog times out (see purgeFeedProducts).
  try {
    const { data: feeds, error: feedsErr } = await db.from('feeds').select('id').eq('project_id', projectId)
    if (feedsErr) throw new Error(feedsErr.message)
    for (const f of (feeds ?? []) as { id: string }[]) await purgeFeedProducts(db, f.id)
  } catch (err) {
    return errorResponse(err, 'DELETE /api/projects/[projectId] purge')
  }
  const { error } = await db
    .from('projects')
    .delete()
    .eq('id', projectId)
    .eq('user_id', user.id)
  if (error) return errorResponse(error, 'DELETE /api/projects/[projectId]')

  return NextResponse.json({ ok: true })
}

// PATCH — rename / update description. Connection changes go through /connect.
export async function PATCH(
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

  const body = (await req.json().catch(() => ({}))) as { name?: string; description?: string }
  const update: { name?: string; description?: string | null; updated_at: string } = {
    updated_at: new Date().toISOString(),
  }
  if (body.name !== undefined) {
    const name = body.name.trim()
    if (!name) return NextResponse.json({ error: 'Name cannot be empty' }, { status: 400 })
    update.name = name
  }
  if (body.description !== undefined) update.description = body.description.trim() || null

  const db = adminDb()
  const { data, error } = await db
    .from('projects')
    .update(update)
    .eq('id', projectId)
    .eq('user_id', user.id)
    .select('id, name, description, shop_url, connection_status, last_verified_at, created_at, updated_at')
    .single()

  if (error) return errorResponse(error, 'PATCH /api/projects/[projectId]')
  return NextResponse.json({ project: data })
}
