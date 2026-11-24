'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { logActivity } from '@/lib/activity'
import { describeRule, isActiveRule, type FeedFilterRule } from '@/lib/feedFilters'
import { getFeedMetafields as getFeedMetafieldsLib, type FeedMetafield } from '@/lib/optimizationBuckets'

export type FilterRule = { field: string; operator: string; value: string; caseSensitive?: boolean }
export type FilterConfig = { operator: 'AND' | 'OR'; rules: FilterRule[] }

// The feed's metafields (namespace.key + product count + resolved definition
// name) so the Filters rule editor can offer a pick-list with readable names
// instead of mangled keys — same data the AI-Titles Scope tab already uses.
export async function getFeedMetafields(
  feedId: string
): Promise<{ data: FeedMetafield[] } | { error: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed ikke fundet' }

  return { data: await getFeedMetafieldsLib(feedId) }
}

export async function saveFilters(
  feedId: string,
  include: FilterConfig,
  exclude: FilterConfig
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed ikke fundet' }

  const db = adminDb()
  const { data: prevRows } = await db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId)
  const { error } = await db.from('feed_filters').upsert(
    [
      { feed_id: feedId, user_id: user.id, filter_type: 'include', operator: include.operator, rules: include.rules },
      { feed_id: feedId, user_id: user.id, filter_type: 'exclude', operator: exclude.operator, rules: exclude.rules },
    ],
    { onConflict: 'feed_id,filter_type' }
  )

  if (error) return { error: error.message }

  // One line per rule added or removed, and when AND/OR flipped.
  const text = (rules: FilterRule[] | null | undefined) =>
    (rules ?? []).map((r) => r as FeedFilterRule).filter(isActiveRule).map(describeRule)
  for (const [type, cfg, word] of [
    ['include', include, 'Inkludér'],
    ['exclude', exclude, 'Ekskludér'],
  ] as const) {
    const p = ((prevRows ?? []) as { filter_type: string; operator: string; rules: FilterRule[] }[]).find((r) => r.filter_type === type)
    const before = text(p?.rules)
    const after = text(cfg.rules)
    for (const r of after.filter((x) => !before.includes(x))) {
      await logActivity(db, { user, feedId, area: 'Inkludér / ekskludér', action: `${word}-regel tilføjet`, after: r })
    }
    for (const r of before.filter((x) => !after.includes(x))) {
      await logActivity(db, { user, feedId, area: 'Inkludér / ekskludér', action: `${word}-regel fjernet`, before: r })
    }
    if (p && p.operator !== cfg.operator && after.length > 1) {
      await logActivity(db, { user, feedId, area: 'Inkludér / ekskludér', action: `${word}: kobling ændret`, before: p.operator === 'AND' ? 'Alle regler' : 'Én af reglerne', after: cfg.operator === 'AND' ? 'Alle regler' : 'Én af reglerne' })
    }
  }
  return {}
}
