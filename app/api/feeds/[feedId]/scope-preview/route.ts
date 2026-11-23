import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { scopePreview } from '@/lib/feedGenerator'
import type { FeedFilter, FeedFilterRule } from '@/lib/feedFilters'

type Body = {
  include?: { operator?: string; rules?: FeedFilterRule[] }
  exclude?: { operator?: string; rules?: FeedFilterRule[] }
  show?: 'included' | 'excluded'
  search?: string
  limit?: number
}

function toFilter(type: 'include' | 'exclude', cfg: Body['include']): FeedFilter {
  const rules = Array.isArray(cfg?.rules)
    ? cfg.rules
        .filter((r) => r && typeof r.field === 'string' && typeof r.operator === 'string')
        .map((r) => ({ ...r, value: String(r.value ?? '') }))
    : []
  return { filter_type: type, operator: cfg?.operator === 'OR' ? 'OR' : 'AND', rules }
}

// POST — what the given (possibly unsaved) include/exclude rules would do to
// the feed: totals, per-rule counts and a searchable list of products on one
// side. Read-only; nothing is saved here (saving goes through saveFilters).
// POST only because the rules travel in the body.
export async function POST(req: Request, { params }: { params: Promise<{ feedId: string }> }) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = (await req.json().catch(() => ({}))) as Body
  try {
    const preview = await scopePreview(feedId, [toFilter('include', body.include), toFilter('exclude', body.exclude)], {
      show: body.show === 'included' ? 'included' : 'excluded',
      search: typeof body.search === 'string' ? body.search.slice(0, 200) : '',
      limit: typeof body.limit === 'number' ? body.limit : 50,
    })
    return NextResponse.json(preview)
  } catch (err) {
    return errorResponse(err, 'POST /api/feeds/[feedId]/scope-preview')
  }
}
