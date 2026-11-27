import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import {
  currentAccountPreference,
  listOwnAccounts,
  pickCurrent,
  rememberCurrentAccount,
  type OwnAccount,
} from '@/lib/currentAccount'
import { blocksApp, getEntitlementsMany, shopsLocked } from '@/lib/entitlements'
import { getMccReach } from '@/lib/mccAccess'
import { errorResponse } from '@/lib/errors'
import { channelOf, type ChannelId } from '@/lib/channels'
import { staleSyncDays } from '@/lib/syncSchedule'

// GET /api/shell — the small, cheap data set the app shell (sidebar, breadcrumbs,
// switchers, user menu) needs on every page: who the user is, their accounts,
// and the shops and feeds the account they're working in can reach
// (lib/currentAccount.ts). No counts, no secrets.
//
// ?project= / ?feed= name the page's shop or feed. When it belongs to another
// of the user's accounts, the shell switches to that account.
export type ShellData = {
  user: { email: string; name: string }
  /** Every account the user is a member of: the account switcher. */
  accounts: { id: string; name: string; type: 'mcc' | 'user'; role: 'owner' | 'admin' | 'member' }[]
  /** The account the user is working in; everything else here is scoped to it. */
  currentAccountId: string | null
  projects: { id: string; accountId: string; name: string; shopUrl: string | null; connectionError?: boolean }[]
  feeds: {
    id: string
    name: string
    projectId: string
    channel: ChannelId
    country: string | null
    /** For the top bar's status pill and the "Needs attention" list. */
    status: FeedStatus
    errors: number
    staleDays: number | null
    /** The last automatic product sync failed. */
    syncFailed?: boolean
  }[]
  attention: {
    /** Changes from assistants waiting for approval, per shop. */
    pendingChanges: { projectId: string; count: number }[]
    /** Automatic runs that failed in the last 7 days (newest first). */
    failures: { feedId: string | null; projectId: string | null; feedLabel: string | null; action: string; message: string | null; at: string }[]
  }
  /** The current account has no usable plan: every page but Billing redirects there (lib/entitlements). */
  blocked: boolean
  /** Gamoba staff: shows the Admin page. */
  isPlatformAdmin: boolean
  /** The current account is an agency (MCC): shows the agency pages. */
  isMcc: boolean
  /** The current account is a customer (User) account: shows Agency access. */
  hasUserAccount: boolean
  /** Agency access requests waiting for this user to approve (owner/admin of the current account). */
  pendingAccess: number
}

async function loadFlags(
  db: ReturnType<typeof adminDb>,
  userId: string,
  memberships: { account_id: string; role: string }[]
): Promise<Pick<ShellData, 'isPlatformAdmin' | 'isMcc' | 'hasUserAccount' | 'pendingAccess'>> {
  const ids = memberships.map((m) => m.account_id)
  const managed = memberships.filter((m) => m.role === 'owner' || m.role === 'admin').map((m) => m.account_id)
  const [admin, types, pending] = await Promise.all([
    db.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle(),
    ids.length ? db.from('accounts').select('type').in('id', ids) : Promise.resolve({ data: [] }),
    managed.length
      ? db.from('access_grants').select('id', { count: 'exact', head: true }).in('user_account_id', managed).eq('status', 'pending')
      : Promise.resolve({ count: 0 }),
  ])
  return {
    isPlatformAdmin: !!admin.data,
    isMcc: ((types.data ?? []) as { type: string }[]).some((t) => t.type === 'mcc'),
    hasUserAccount: ((types.data ?? []) as { type: string }[]).some((t) => t.type === 'user'),
    pendingAccess: (pending as { count: number | null }).count ?? 0,
  }
}

export type FeedStatus = 'running' | 'errors' | 'not_generated' | 'stale'

// The account a shop or feed belongs to, from the user's point of view: the
// owning account when they're a member of it, else the agency of theirs whose
// grant reaches it. Null when neither (the page's own lookup then says no).
async function accountForHint(
  db: ReturnType<typeof adminDb>,
  own: OwnAccount[],
  currentId: string | null,
  projectId: string | null,
  feedId: string | null
): Promise<OwnAccount | null> {
  const uuid = /^[0-9a-f-]{36}$/i
  let accountId: string | null = null
  if (feedId && uuid.test(feedId)) {
    const { data } = await db.from('feeds').select('projects!inner(account_id)').eq('id', feedId).maybeSingle()
    const pr = (data as { projects?: { account_id: string } | { account_id: string }[] } | null)?.projects
    accountId = (Array.isArray(pr) ? pr[0]?.account_id : pr?.account_id) ?? null
  } else if (projectId && uuid.test(projectId)) {
    const { data } = await db.from('projects').select('account_id').eq('id', projectId).maybeSingle<{ account_id: string }>()
    accountId = data?.account_id ?? null
  }
  if (!accountId) return null
  const member = own.find((a) => a.id === accountId)
  if (member) return member
  const mccs = own.filter((a) => a.type === 'mcc')
  if (!mccs.length) return null
  const { data: grants } = await db
    .from('access_grants')
    .select('mcc_account_id, scope, feed_id')
    .in('mcc_account_id', mccs.map((a) => a.id))
    .eq('user_account_id', accountId)
    .eq('status', 'active')
  const rows = (grants ?? []) as { mcc_account_id: string; scope: string; feed_id: string | null }[]
  const covers = (g: (typeof rows)[number]) => g.scope === 'account' || (!!feedId && g.feed_id === feedId)
  // The agency the user is working in, when it reaches the shop; else any.
  const hit = rows.find((g) => covers(g) && g.mcc_account_id === currentId) ?? rows.find(covers)
  return hit ? (mccs.find((a) => a.id === hit.mcc_account_id) ?? null) : null
}

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const db = adminDb()
    const url = new URL(req.url)
    const own = await listOwnAccounts(db, user.id)
    let current = pickCurrent(own, await currentAccountPreference())
    const hinted = await accountForHint(db, own, current?.id ?? null, url.searchParams.get('project'), url.searchParams.get('feed'))
    if (hinted && hinted.id !== current?.id) {
      current = hinted
      await rememberCurrentAccount(hinted.id)
    }
    // Everything below is scoped to the current account.
    const memberships = current ? [{ account_id: current.id, role: current.role }] : []
    const allAccountIds = memberships.map((m) => m.account_id)
    // Accounts without a usable plan show no shops or feeds (lib/entitlements).
    // When none of the user's User accounts can be used, the shell sends them
    // to Billing (`blocked`).
    const ents = await getEntitlementsMany(db, allAccountIds)
    const accountIds = allAccountIds.filter((id) => {
      const e = ents.get(id)
      return !e || !shopsLocked(e)
    })
    const blocked = allAccountIds.length > 0 && allAccountIds.every((id) => {
      const e = ents.get(id)
      return !!e && blocksApp(e)
    })

    // Clients reached through an agency (lib/mccAccess.ts): whole accounts,
    // and single feeds. Locked client accounts are left out, as above.
    const reach = current?.type === 'mcc' ? await getMccReach(db, user.id, current.id) : { accountIds: [], feeds: [] }
    const clientEnts = await getEntitlementsMany(db, [...reach.accountIds, ...reach.feeds.map((f) => f.accountId)])
    const usable = (id: string) => {
      const e = clientEnts.get(id)
      return !!e && !shopsLocked(e)
    }
    const clientAccountIds = reach.accountIds.filter((id) => usable(id) && !accountIds.includes(id))
    const clientFeedIds = reach.feeds.filter((f) => usable(f.accountId)).map((f) => f.feedId)
    const shopAccountIds = [...accountIds, ...clientAccountIds]
    let feedOnlyProjectIds: string[] = []
    if (clientFeedIds.length) {
      const { data: fp } = await db.from('feeds').select('project_id').in('id', clientFeedIds)
      feedOnlyProjectIds = [...new Set(((fp ?? []) as { project_id: string }[]).map((r) => r.project_id))]
    }

    // Account names come from listOwnAccounts above; only the shops are read here.
    const projectsRes =
      shopAccountIds.length || feedOnlyProjectIds.length
        ? await db
            .from('projects')
            .select('id, account_id, name, shop_url, primary_domain, source_type, connection_status')
            .or(
              [
                shopAccountIds.length ? `account_id.in.(${shopAccountIds.join(',')})` : '',
                feedOnlyProjectIds.length ? `id.in.(${feedOnlyProjectIds.join(',')})` : '',
              ]
                .filter(Boolean)
                .join(',')
            )
            .order('created_at', { ascending: true })
        : { data: [], error: null }
    if (projectsRes.error) throw projectsRes.error

    const projects = (projectsRes.data ?? []) as {
      id: string
      account_id: string
      name: string
      shop_url: string | null
      primary_domain: string | null
      source_type: string | null
      connection_status?: string | null
    }[]
    const projectIds = projects.map((p) => p.id)

    let feeds: ShellData['feeds'] = []
    // Independent of each other, so they run together (each round trip to the
    // database counts on every page load).
    const [feedsRes, attention] = await Promise.all([
      projectIds.length
        ? db.from('feeds').select('*').in('project_id', projectIds).order('created_at', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      loadAttention(db, accountIds, projectIds),
    ])
    if (projectIds.length) {
      const { data: feedRows, error: feedErr } = feedsRes
      if (feedErr) throw feedErr
      // A shop reached through a single-feed grant shows only that feed.
      const wholeShop = new Set(projects.filter((p) => shopAccountIds.includes(p.account_id)).map((p) => p.id))
      const rows = ((feedRows ?? []) as { id: string; name: string; project_id: string; channel: string; last_synced_at?: string | null; last_auto_sync_status?: string | null }[])
        .filter((r) => wholeShop.has(r.project_id) || clientFeedIds.includes(r.id))
      // Small columns only: never xml_content. Cache and markets together.
      const ids = rows.map((r) => r.id)
      const [{ data: caches }, settingsRes] = rows.length
        ? await Promise.all([
            db.from('feed_cache').select('feed_id, generated_at, validation_errors').in('feed_id', ids),
            db.from('shop_settings').select('feed_id, selected_country').in('feed_id', ids),
          ])
        : [{ data: [] }, { data: [], error: null }]
      const cache = new Map(
        ((caches ?? []) as { feed_id: string; generated_at: string | null; validation_errors: { type?: string }[] | null }[]).map((c) => [c.feed_id, c])
      )

      // The feed's market (country) for the flag. Lives in shop_settings today.
      const country = new Map<string, string | null>()
      if (rows.length) {
        const { data: settings, error: setErr } = settingsRes
        if (setErr) throw setErr
        for (const s of (settings ?? []) as { feed_id: string; selected_country: string | null }[]) {
          country.set(s.feed_id, s.selected_country)
        }
      }
      feeds = rows.map((r) => ({
        id: r.id,
        name: r.name,
        projectId: r.project_id,
        channel: channelOf(r.channel).id,
        country: country.get(r.id) ?? null,
        ...feedState(cache.get(r.id), r.last_synced_at ?? null),
        syncFailed: r.last_auto_sync_status === 'error',
      }))
    }


    const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string }
    const body: ShellData = {
      user: {
        email: user.email ?? '',
        name: meta.full_name || meta.name || user.email || '',
      },
      accounts: own.map((a) => ({ id: a.id, name: a.name, type: a.type, role: a.role })),
      currentAccountId: current?.id ?? null,
      projects: projects.map((p) => ({
        id: p.id,
        connectionError: p.source_type !== 'feed_url' && p.connection_status === 'error',
        accountId: p.account_id,
        name: p.name,
        shopUrl: p.source_type === 'feed_url' ? (p.primary_domain ?? null) : p.shop_url,
      })),
      feeds,
      attention,
      blocked,
      ...(await loadFlags(db, user.id, memberships)),
    }
    return NextResponse.json(body)
  } catch (err) {
    return errorResponse(err, 'GET /api/shell')
  }
}

function feedState(
  cache: { generated_at: string | null; validation_errors: { type?: string }[] | null } | undefined,
  lastSynced: string | null
): { status: FeedStatus; errors: number; staleDays: number | null } {
  const errors = (cache?.validation_errors ?? []).filter((i) => i?.type === 'error').length
  const staleDays = staleSyncDays(lastSynced)
  const status: FeedStatus = !cache?.generated_at ? 'not_generated' : errors > 0 ? 'errors' : staleDays !== null ? 'stale' : 'running'
  return { status, errors, staleDays }
}

// Best effort: either table may be missing on an older database, and the shell
// must load regardless.
async function loadAttention(
  db: ReturnType<typeof adminDb>,
  accountIds: string[],
  projectIds: string[]
): Promise<ShellData['attention']> {
  const out: ShellData['attention'] = { pendingChanges: [], failures: [] }
  if (!accountIds.length) return out
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const [pending, failed] = await Promise.all([
    projectIds.length
      ? db.from('mcp_changes').select('project_id').eq('status', 'pending').in('project_id', projectIds).limit(500)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('activity_log')
      .select('feed_id, project_id, feed_label, action, after, created_at')
      .in('account_id', accountIds)
      .is('user_id', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(20),
  ])
  if (!pending.error) {
    const n = new Map<string, number>()
    for (const r of (pending.data ?? []) as { project_id: string | null }[]) {
      if (r.project_id) n.set(r.project_id, (n.get(r.project_id) ?? 0) + 1)
    }
    out.pendingChanges = [...n].map(([projectId, count]) => ({ projectId, count }))
  }
  if (!failed.error) {
    out.failures = ((failed.data ?? []) as { feed_id: string | null; project_id: string | null; feed_label: string | null; action: string; after: string | null; created_at: string }[]).map((r) => ({
      feedId: r.feed_id,
      projectId: r.project_id,
      feedLabel: r.feed_label,
      action: r.action,
      message: r.after,
      at: r.created_at,
    }))
  }
  return out
}
