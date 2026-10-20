import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { saveBucket, deleteBucket, type Bucket } from '@/lib/googleAdsBuckets'
import { errorResponse } from '@/lib/errors'

// Buckets are the values inside one custom label. Listing them is the label
// route's job (a value list without its dimension is not actionable); this
// route only creates, edits and removes individual values.

async function guard(feedId: string) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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

    const body = (await req.json().catch(() => ({}))) as { bucket?: Partial<Bucket> }
    if (!body.bucket) {
      return NextResponse.json({ error: 'bucket is required' }, { status: 400 })
    }

    return NextResponse.json({ bucket: await saveBucket(adminDb(), feedId, body.bucket) })
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

    await deleteBucket(adminDb(), feedId, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'DELETE /api/google-ads/[feedId]/buckets')
  }
}
