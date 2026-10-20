import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import {
  listLabels,
  listBuckets,
  saveLabel,
  deleteLabel,
  type CustomLabel,
} from '@/lib/googleAdsBuckets'
import { errorResponse } from '@/lib/errors'

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

// GET — every custom label on the feed, with its buckets.
//
// Both in one response because a label without its values is not a thing anyone
// can act on, and two round-trips could disagree with each other.
export async function GET(_req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  try {
    const { feedId } = await params
    const g = await guard(feedId)
    if ('error' in g) return g.error

    const db = adminDb()
    const [labels, buckets] = await Promise.all([listLabels(db, feedId), listBuckets(db, feedId)])
    return NextResponse.json({ labels, buckets })
  } catch (err) {
    return errorResponse(err, 'GET /api/google-ads/[feedId]/labels')
  }
}

// There is no 'seed' action. There was one, creating a hardcoded "Performance"
// dimension, and it was removed rather than left switched off: the thresholds in
// it were a guess, and a guess presented as a suggestion gets adopted. Templates
// are coming from the person who actually runs the accounts, and they will be a
// SET of choices rather than one hardcoded dimension — a different shape than
// this endpoint had.
type Body = {
  action?: 'save'
  label?: Partial<CustomLabel>
}

export async function POST(req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  try {
    const { feedId } = await params
    const g = await guard(feedId)
    if ('error' in g) return g.error

    const db = adminDb()
    const body = (await req.json().catch(() => ({}))) as Body

    if (!body.label) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 })
    }
    return NextResponse.json({ label: await saveLabel(db, feedId, body.label) })
  } catch (err) {
    return errorResponse(err, 'POST /api/google-ads/[feedId]/labels')
  }
}

// DELETE — the label, and with it its buckets and their membership (cascade).
export async function DELETE(req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  try {
    const { feedId } = await params
    const g = await guard(feedId)
    if ('error' in g) return g.error

    const id = new URL(req.url).searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    await deleteLabel(adminDb(), feedId, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'DELETE /api/google-ads/[feedId]/labels')
  }
}
