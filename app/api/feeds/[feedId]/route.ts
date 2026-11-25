import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed, purgeFeedProducts } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { feedLabel, logActivity } from '@/lib/activity'

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const db = adminDb()
  // Read the label now: after the delete there is no feed to describe.
  const label = await feedLabel(db, feedId).catch(() => null)
  // Products first, in batches — a single cascading delete of a large catalog
  // times out. ON DELETE CASCADE on feed_id FKs then handles the rest.
  try {
    await purgeFeedProducts(db, feedId)
  } catch (err) {
    return errorResponse(err, 'DELETE /api/feeds/[feedId] purge')
  }
  // Access was checked by getOwnedFeed (account membership) above.
  const { error } = await db.from('feeds').delete().eq('id', feedId)
  if (error) return errorResponse(error, 'DELETE /api/feeds/[feedId]')

  await logActivity(db, {
    user,
    feedId,
    feedLabel: label?.label ?? owned.name,
    projectId: owned.project_id ?? undefined,
    area: 'Feed',
    action: 'Feed slettet',
    before: owned.name,
  })
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as { name?: string; description?: string }
  const update: { name?: string; description?: string | null; updated_at: string } = {
    updated_at: new Date().toISOString(),
  }
  if (body.name !== undefined) update.name = body.name.trim()
  if (body.description !== undefined) update.description = body.description.trim() || null

  const db = adminDb()
  const { data, error } = await db
    .from('feeds')
    .update(update)
    .eq('id', feedId)
    .select('id, name, description, created_at, updated_at')
    .single()

  if (error) return errorResponse(error, 'PATCH /api/feeds/[feedId]')
  if (update.name !== undefined && update.name !== owned.name) {
    await logActivity(db, { user, feedId, area: 'Feed', action: 'Feed omdøbt', before: owned.name, after: update.name })
  }
  if (update.description !== undefined && update.description !== (owned.description ?? null)) {
    await logActivity(db, { user, feedId, area: 'Feed', action: 'Beskrivelse ændret', before: owned.description, after: update.description })
  }
  return NextResponse.json({ feed: data })
}
