// Changes an assistant asks for (migration 057).
//
// Every write tool goes through proposeChange. If the agency has turned on
// "apply without approval" (accounts.mcp_auto_apply) the change is applied
// straight away; otherwise it waits in mcp_changes until an agency member
// approves or rejects it under Shop › API / MCP. Either way the row stays as a
// record of what the assistant asked for and what happened.
//
// Applying calls the same functions as the UI (lib/ops/feedConfig), so a change
// from Claude is checked, logged and cached exactly like one made by hand.

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { feedLabel, logActivity } from '@/lib/activity'
import {
  applyAdsSchedule,
  applyFeedMode,
  applyFeedSchedule,
  applyFilters,
  applyMappings,
  type FeedMode,
  type FilterConfig,
  type MappingEntry,
  type OpResult,
} from '@/lib/ops/feedConfig'

export type ChangePayload =
  | { kind: 'mapping'; entries: MappingEntry[] }
  | { kind: 'filters'; include: FilterConfig; exclude: FilterConfig }
  | { kind: 'feed_mode'; mode: FeedMode }
  | { kind: 'feed_schedule'; frequency: string; time: string }
  | { kind: 'ads_schedule'; frequency: string; time: string }

export type ChangeDetail = { label: string; before: string | null; after: string | null }

export type ChangeStatus = 'pending' | 'applied' | 'rejected' | 'failed'

export type ChangeRow = {
  id: number
  account_id: string
  project_id: string | null
  feed_id: string | null
  feed_label: string | null
  kind: ChangePayload['kind']
  payload: ChangePayload
  summary: string
  details: ChangeDetail[]
  status: ChangeStatus
  error: string | null
  requested_by: string | null
  requested_by_name: string
  client_name: string | null
  decided_by_name: string | null
  decided_at: string | null
  created_at: string
}

export const AREA: Record<ChangePayload['kind'], string> = {
  mapping: 'Mapping',
  filters: 'Include / exclude',
  feed_mode: 'Settings',
  feed_schedule: 'Settings',
  ads_schedule: 'Settings',
}

export function displayName(user: Pick<User, 'email' | 'user_metadata'>): string {
  const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string }
  return meta.full_name || meta.name || user.email || 'Unknown user'
}

// "Claude" when the OAuth client says so; the registered name otherwise.
export async function clientName(db: SupabaseClient, clientId: string | null): Promise<string> {
  if (!clientId) return 'AI assistant'
  try {
    const { data } = await db.auth.admin.oauth.getClient(clientId)
    const name = (data as { client_name?: string } | null)?.client_name?.trim()
    if (!name) return 'AI assistant'
    return /claude/i.test(name) ? 'Claude' : name
  } catch {
    return 'AI assistant'
  }
}

function run(db: SupabaseClient, ctx: { user: User; via: string }, feedId: string, p: ChangePayload): Promise<OpResult> {
  switch (p.kind) {
    case 'mapping':
      return applyMappings(db, ctx, feedId, p.entries)
    case 'filters':
      return applyFilters(db, ctx, feedId, p.include, p.exclude)
    case 'feed_mode':
      return applyFeedMode(db, ctx, feedId, p.mode)
    case 'feed_schedule':
      return applyFeedSchedule(db, ctx, feedId, p.frequency, p.time)
    case 'ads_schedule':
      return applyAdsSchedule(db, ctx, feedId, p.frequency, p.time)
  }
}

export type ProposeInput = {
  user: User
  client: string
  feed: { id: string; project_id: string | null; account_id: string }
  payload: ChangePayload
  summary: string
  details: ChangeDetail[]
}

export type ProposeResult = { id: number; status: ChangeStatus; error?: string }

export async function proposeChange(db: SupabaseClient, input: ProposeInput): Promise<ProposeResult> {
  const { data: account, error: accErr } = await db
    .from('accounts')
    .select('mcp_auto_apply')
    .eq('id', input.feed.account_id)
    .maybeSingle<{ mcp_auto_apply: boolean }>()
  if (accErr) dbError('proposeChange account', accErr)
  const auto = !!account?.mcp_auto_apply
  const label = (await feedLabel(db, input.feed.id))?.label ?? null

  const { data: row, error } = await db
    .from('mcp_changes')
    .insert({
      account_id: input.feed.account_id,
      project_id: input.feed.project_id,
      feed_id: input.feed.id,
      feed_label: label,
      kind: input.payload.kind,
      payload: input.payload,
      summary: input.summary,
      details: input.details,
      status: 'pending',
      requested_by: input.user.id,
      requested_by_name: displayName(input.user),
      client_name: input.client,
    })
    .select('id')
    .single<{ id: number }>()
  if (error) dbError('proposeChange insert', error)
  if (!auto) return { id: row.id, status: 'pending' }

  const result = await run(db, { user: input.user, via: input.client }, input.feed.id, input.payload)
  const status: ChangeStatus = result.error ? 'failed' : 'applied'
  await db
    .from('mcp_changes')
    .update({ status, error: result.error ?? null, decided_by_name: 'Applied without approval', decided_at: new Date().toISOString() })
    .eq('id', row.id)
  return { id: row.id, status, error: result.error }
}

// Approve (apply) or reject a pending change. The caller has checked that
// `actor` is a member of the change's account.
export async function decideChange(
  db: SupabaseClient,
  actor: User,
  changeId: number,
  approve: boolean
): Promise<ProposeResult> {
  // Claim the row first, so two people clicking at once can't apply it twice.
  const now = new Date().toISOString()
  const { data: claimed, error } = await db
    .from('mcp_changes')
    .update({
      status: approve ? 'applied' : 'rejected',
      decided_by: actor.id,
      decided_by_name: displayName(actor),
      decided_at: now,
    })
    .eq('id', changeId)
    .eq('status', 'pending')
    .select('*')
  if (error) dbError('decideChange', error)
  const row = (claimed?.[0] as ChangeRow | undefined) ?? null
  if (!row) throw new AppError('The change has already been handled', 409)
  if (!approve || !row.feed_id) {
    if (row.feed_id) {
      await logActivity(db, { user: actor, feedId: row.feed_id, area: AREA[row.kind], action: `Change from ${row.client_name ?? 'assistant'} rejected`, after: row.summary })
    }
    return { id: row.id, status: 'rejected' }
  }

  // Applied as the person who asked for it ("Anna via Claude"), so the
  // Activity log says who wanted the change; the approval is logged too.
  let requester: User = actor
  if (row.requested_by && row.requested_by !== actor.id) {
    const { data } = await db.auth.admin.getUserById(row.requested_by)
    if (data?.user) requester = data.user
  }
  const result = await run(db, { user: requester, via: row.client_name ?? 'AI assistant' }, row.feed_id, row.payload)
  if (result.error) {
    await db.from('mcp_changes').update({ status: 'failed', error: result.error }).eq('id', row.id)
    return { id: row.id, status: 'failed', error: result.error }
  }
  if (requester.id !== actor.id) {
    await logActivity(db, { user: actor, feedId: row.feed_id, area: AREA[row.kind], action: `Change from ${row.client_name ?? 'assistant'} approved`, after: row.summary })
  }
  return { id: row.id, status: 'applied' }
}

export async function listChanges(
  db: SupabaseClient,
  filter: { projectIds: string[]; status?: ChangeStatus; limit?: number }
): Promise<ChangeRow[]> {
  if (!filter.projectIds.length) return []
  let q = db
    .from('mcp_changes')
    .select('*')
    .in('project_id', filter.projectIds)
    .order('created_at', { ascending: false })
    .limit(filter.limit ?? 50)
  if (filter.status) q = q.eq('status', filter.status)
  const { data, error } = await q
  // Before migration 057 the table is missing: no changes, not an error page.
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return []
    dbError('listChanges', error)
  }
  return (data ?? []) as ChangeRow[]
}
