import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { recomputeFeed, recomputeLabel } from '@/lib/googleAdsBuckets'
import { errorResponse } from '@/lib/errors'

// POST — re-evaluate the rules against the stored metrics.
//
// With a labelId, only that dimension is rewritten and the others are left
// exactly as they were; without one, every label is recomputed in turn.
//
// Not rate-limited: this touches no external API. It reads data already synced
// and rewrites membership, so it is cheap and safe to run on every rule edit.
export async function POST(req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  try {
    const { feedId } = await params

    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const feed = await getOwnedFeed(user.id, feedId)
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { labelId } = (await req.json().catch(() => ({}))) as { labelId?: string }
    const db = adminDb()

    const result = labelId
      ? await recomputeLabel(db, feedId, labelId)
      : await recomputeFeed(db, feedId)

    return NextResponse.json({ ok: true, result })
  } catch (err) {
    return errorResponse(err, 'POST /api/google-ads/[feedId]/labels/recompute')
  }
}
