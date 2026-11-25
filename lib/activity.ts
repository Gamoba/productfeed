// Activity log (migration 056): record who changed what, and read it back for
// Shop › Activity log.
//
// logActivity is best effort. It is called after a change has been saved, and
// a failure to log (a missing table before the migration, a hiccup) is only
// logged to the server console. It never throws, so it can't undo or fail the
// change it describes.

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { channelOf } from '@/lib/channels'
import { countryName } from '@/lib/formatDa'

export type Actor = Pick<User, 'id' | 'email' | 'user_metadata'> | null

export type ActivityInput = {
  /** null = the system (scheduled runs). */
  user: Actor
  /** Made through an assistant: shown as "Name via Claude". */
  via?: string
  area: string
  action: string
  before?: string | number | null
  after?: string | number | null
  /** Give the most specific one; the rest is looked up. */
  feedId?: string
  /** The feed's label when the feed is already gone (deleted). */
  feedLabel?: string | null
  projectId?: string
  accountId?: string
}

export type ActivityRow = {
  id: number
  at: string
  actor: string
  isSystem: boolean
  where: string
  area: string
  action: string
  before: string | null
  after: string | null
}

const clip = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined || v === '') return null
  const s = String(v)
  return s.length > 300 ? `${s.slice(0, 297)}…` : s
}

function actorName(user: Actor): string {
  if (!user) return 'System'
  const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string }
  return meta.full_name || meta.name || user.email || 'Ukendt bruger'
}

// "Google Shopping · Tyskland", from the feed's channel and market.
export async function feedLabel(db: SupabaseClient, feedId: string): Promise<{ label: string; projectId: string | null } | null> {
  const [{ data: feed }, { data: market }] = await Promise.all([
    db.from('feeds').select('*').eq('id', feedId).maybeSingle(),
    db.from('shop_settings').select('selected_country').eq('feed_id', feedId).maybeSingle(),
  ])
  if (!feed) return null
  const f = feed as { name: string; project_id: string | null; channel?: string | null }
  const country = (market as { selected_country?: string | null } | null)?.selected_country
  const label = [channelOf(f.channel).label, country ? countryName(country) : f.name].join(' · ')
  return { label, projectId: f.project_id }
}

// Where a feed's activity belongs (label, shop, account), resolved once. Pass it
// along with each line when one save logs several, so logActivity doesn't look
// the same feed up again for every line.
export type ActivityTarget = { feedId: string; feedLabel: string | null; projectId: string | null; accountId: string | null }

export async function activityTarget(db: SupabaseClient, feedId: string): Promise<ActivityTarget> {
  const f = await feedLabel(db, feedId)
  const projectId = f?.projectId ?? null
  let accountId: string | null = null
  if (projectId) {
    const { data } = await db.from('projects').select('account_id').eq('id', projectId).maybeSingle()
    accountId = (data as { account_id?: string } | null)?.account_id ?? null
  }
  return { feedId, feedLabel: f?.label ?? null, projectId, accountId }
}

// Several lines from one change, written together.
export async function logActivities(
  db: SupabaseClient,
  feedId: string,
  lines: Omit<ActivityInput, 'feedId' | 'feedLabel' | 'projectId' | 'accountId'>[]
): Promise<void> {
  if (lines.length === 0) return
  try {
    const target = await activityTarget(db, feedId)
    if (!target.accountId) return
    await Promise.all(
      lines.map((l) =>
        logActivity(db, {
          ...l,
          feedId,
          feedLabel: target.feedLabel,
          projectId: target.projectId ?? undefined,
          accountId: target.accountId ?? undefined,
        })
      )
    )
  } catch (err) {
    console.error('[activity] could not log:', err)
  }
}

export async function logActivity(db: SupabaseClient, input: ActivityInput): Promise<void> {
  try {
    let projectId = input.projectId ?? null
    let label: string | null = input.feedLabel ?? null
    if (input.feedId && !label) {
      const f = await feedLabel(db, input.feedId)
      label = f?.label ?? null
      projectId ??= f?.projectId ?? null
    }
    let accountId = input.accountId ?? null
    if (!accountId && projectId) {
      const { data } = await db.from('projects').select('account_id').eq('id', projectId).maybeSingle()
      accountId = (data as { account_id?: string } | null)?.account_id ?? null
    }
    if (!accountId) return

    const { error } = await db.from('activity_log').insert({
      account_id: accountId,
      project_id: projectId,
      feed_id: input.feedId ?? null,
      feed_label: label,
      user_id: input.user?.id ?? null,
      actor: input.via ? `${actorName(input.user)} via ${input.via}` : actorName(input.user),
      area: input.area,
      action: clip(input.action) ?? input.area,
      before: clip(input.before),
      after: clip(input.after),
    })
    if (error) console.error('[activity] insert failed:', error.message)
  } catch (err) {
    console.error('[activity] could not log:', err)
  }
}

// One mapping as a short line: "Felt: vendor", "Fast tekst: Gamoba", "AI".
export function describeMapping(type: string | null | undefined, config: Record<string, unknown> | null | undefined): string | null {
  if (!type) return null
  const c = config ?? {}
  const field = typeof c.field === 'string' && c.field ? c.field : null
  switch (type) {
    case 'FIELD':
      return field ? `Felt: ${field}` : 'Felt'
    case 'STATIC':
      return `Fast tekst: ${String(c.value ?? '')}`
    case 'COMBINE':
      return 'Kombineret'
    case 'PREFIX_SUFFIX':
      return field ? `Før/efter-tekst på ${field}` : 'Før/efter-tekst'
    case 'FIND_REPLACE':
      return field ? `Find og erstat på ${field}` : 'Find og erstat'
    case 'TRUNCATE':
      return field ? `Afkortet ${field}` : 'Afkortet'
    case 'STRIP_HTML':
      return field ? `${field} uden HTML` : 'Uden HTML'
    case 'LOOKUP':
      return field ? `Opslagstabel på ${field}` : 'Opslagstabel'
    case 'AI':
      return 'AI'
    default:
      return type
  }
}

/** Newest first: the shop's own events plus account-wide ones (users). */
export const ACTIVITY_LIMIT = 500

export async function getShopActivity(
  db: SupabaseClient,
  projectId: string,
  accountId: string
): Promise<{ rows: ActivityRow[]; available: boolean }> {
  const { data, error } = await db
    .from('activity_log')
    .select('id, created_at, actor, user_id, feed_label, project_id, area, action, before, after')
    .eq('account_id', accountId)
    .or(`project_id.eq.${projectId},project_id.is.null`)
    .order('created_at', { ascending: false })
    .limit(ACTIVITY_LIMIT)
  // Before migration 056 the table doesn't exist; the page says so instead of failing.
  if (error) {
    console.error('[activity] read failed:', error.message)
    return { rows: [], available: false }
  }
  return {
    available: true,
    rows: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      at: String(r.created_at),
      actor: String(r.actor),
      isSystem: r.user_id === null && r.actor === 'System',
      where: (r.feed_label as string | null) ?? (r.project_id ? 'Shop' : 'Konto'),
      area: String(r.area),
      action: String(r.action),
      before: (r.before as string | null) ?? null,
      after: (r.after as string | null) ?? null,
    })),
  }
}
