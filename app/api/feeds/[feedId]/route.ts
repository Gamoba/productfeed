import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed, purgeFeedProducts } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const db = adminDb()
  // Products first, in batches — a single cascading delete of a large catalog
  // times out. ON DELETE CASCADE on feed_id FKs then handles the rest.
  try {
    await purgeFeedProducts(db, feedId)
  } catch (err) {
    return errorResponse(err, 'DELETE /api/feeds/[feedId] purge')
  }
  const { error } = await db.from('feeds').delete().eq('id', feedId).eq('user_id', user.id)
  if (error) return errorResponse(error, 'DELETE /api/feeds/[feedId]')

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
  } = await supabase.auth.getUser()
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
    .eq('user_id', user.id)
    .select('id, name, description, created_at, updated_at')
    .single()

  if (error) return errorResponse(error, 'PATCH /api/feeds/[feedId]')
  return NextResponse.json({ feed: data })
}
