import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import { errorResponse } from '@/lib/errors'
import { extractCoverage } from '@/lib/feedGenerator'
import {
  MAX_PATTERN_LENGTH,
  patternProblems,
  type ExtractConfig,
  type ExtractPattern,
  type LookupEntry,
} from '@/lib/mappingExtract'

// Coverage check for an EXTRACT mapping while it's being edited: runs the
// (unsaved) patterns over every item the feed would emit and returns how many
// matched, per-pattern counts, the most common values, a sample of misses and
// the patterns that can't be used (patternErrors).
// Reads our own database only — nothing here talks to Shopify.
//
// POST /api/mapping/extract-test?feedId=…  body: { field, patterns, lookup }

const MAX_PATTERNS = 50
const MAX_LOOKUP = 500

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

// Accepts only the shape we evaluate, so the body can't smuggle anything else
// into the config or make the check arbitrarily large.
function parseConfig(body: unknown): ExtractConfig | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const field = str(b.field, 200)
  if (!field) return null
  const patterns: ExtractPattern[] = (Array.isArray(b.patterns) ? b.patterns : [])
    .slice(0, MAX_PATTERNS)
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>
      // Capped well above MAX_PATTERN_LENGTH, so an over-long pattern is still
      // refused by the evaluator instead of being shortened into a valid one.
      return {
        pattern: str(o.pattern, MAX_PATTERN_LENGTH + 1000),
        template: str(o.template, 500),
        ignoreCase: o.ignoreCase === true,
      }
    })
  const lookup: LookupEntry[] = (Array.isArray(b.lookup) ? b.lookup : [])
    .slice(0, MAX_LOOKUP)
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>
      return { from: str(o.from, 200), to: str(o.to, 200) }
    })
  return { field, patterns, lookup }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const feedId = new URL(req.url).searchParams.get('feedId')
  if (!feedId) return NextResponse.json({ error: 'feedId mangler' }, { status: 400 })

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return NextResponse.json({ error: 'Feed ikke fundet' }, { status: 404 })

  const config = parseConfig(await req.json().catch(() => null))
  if (!config) return NextResponse.json({ error: 'Vælg et kildefelt først' }, { status: 400 })

  try {
    // patternErrors: the patterns the run skipped and why (0-based index), so a
    // refused pattern reads as an error instead of a silent 0 matches.
    const coverage = await extractCoverage(feedId, config)
    return NextResponse.json({ ...coverage, patternErrors: patternProblems(config.patterns) })
  } catch (err) {
    return errorResponse(err, 'POST /api/mapping/extract-test')
  }
}
