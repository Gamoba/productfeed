import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { saveBucket, deleteBucket, listBuckets, recomputeLabel, type Bucket } from '@/lib/googleAdsBuckets'
import { logActivity } from '@/lib/activity'
import { errorResponse } from '@/lib/errors'

// Buckets are the values inside one custom label. Listing them is the label
// route's job (a value list without its dimension is not actionable); this
// route only creates, edits and removes individual values.

async function guard(feedId: string) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) }
  return { user, feed }
}

export async function POST(req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  try {
    const { feedId } = await params
    const g = await guard(feedId)
    if ('error' in g) return g.error

    // recompute: true recalculates the bucket's label in the same request, so
    // the page doesn't wait for a second round trip.
    const body = (await req.json().catch(() => ({}))) as { bucket?: Partial<Bucket>; recompute?: boolean }
    if (!body.bucket) {
      return NextResponse.json({ error: 'bucket is required' }, { status: 400 })
    }

    const db = adminDb()
    const saved = await saveBucket(db, feedId, body.bucket)
    await logActivity(db, {
      user: g.user,
      feedId,
      area: 'Labels',
      action: body.bucket.id ? 'Bucket ændret' : 'Bucket oprettet',
      after: saved.name === saved.value ? saved.name : `${saved.name} → ${saved.value}`,
    })
    const result = body.recompute ? await recomputeLabel(db, feedId, saved.label_id) : undefined
    return NextResponse.json({ bucket: saved, ...(result ? { result } : {}) })
  } catch (err) {
    return errorResponse(err, 'POST /api/google-ads/[feedId]/buckets')
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  try {
    const { feedId } = await params
    const g = await guard(feedId)
    if ('error' in g) return g.error

    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    const db = adminDb()
    const bucket = (await listBuckets(db, feedId)).find((b) => b.id === id)
    await deleteBucket(db, feedId, id)
    await logActivity(db, { user: g.user, feedId, area: 'Labels', action: 'Bucket slettet', before: bucket?.name ?? null })
    // recompute=1: recalculate the bucket's label in the same request.
    const result =
      bucket && new URL(req.url).searchParams.get('recompute') === '1' ? await recomputeLabel(db, feedId, bucket.label_id) : undefined
    return NextResponse.json({ ok: true, ...(result ? { result } : {}) })
  } catch (err) {
    return errorResponse(err, 'DELETE /api/google-ads/[feedId]/buckets')
  }
}
