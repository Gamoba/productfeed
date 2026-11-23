import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getMemberships } from '@/lib/accounts'
import { errorResponse } from '@/lib/errors'

// GET /api/shell — the small, cheap data set the app shell (sidebar, breadcrumbs,
// switchers, user menu) needs on every page: who the user is, their accounts,
// and the shops and feeds they can reach. No counts, no secrets.
export type ShellData = {
  user: { email: string; name: string }
  accounts: { id: string; name: string; role: 'owner' | 'admin' | 'member' }[]
  projects: { id: string; accountId: string; name: string; shopUrl: string | null }[]
  feeds: { id: string; name: string; projectId: string; country: string | null }[]
}

export async function GET() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const db = adminDb()
    const memberships = await getMemberships(db, user.id)
    const accountIds = memberships.map((m) => m.account_id)

    const [accountsRes, projectsRes] = accountIds.length
      ? await Promise.all([
          db.from('accounts').select('id, name').in('id', accountIds),
          db
            .from('projects')
            .select('id, account_id, name, shop_url, primary_domain, source_type')
            .in('account_id', accountIds)
            .order('created_at', { ascending: true }),
        ])
      : [{ data: [], error: null }, { data: [], error: null }]
    if (accountsRes.error) throw accountsRes.error
    if (projectsRes.error) throw projectsRes.error

    const accountName = new Map(
      ((accountsRes.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name])
    )
    const projects = (projectsRes.data ?? []) as {
      id: string
      account_id: string
      name: string
      shop_url: string | null
      primary_domain: string | null
      source_type: string | null
    }[]
    const projectIds = projects.map((p) => p.id)

    let feeds: ShellData['feeds'] = []
    if (projectIds.length) {
      const { data: feedRows, error: feedErr } = await db
        .from('feeds')
        .select('id, name, project_id')
        .in('project_id', projectIds)
        .order('created_at', { ascending: true })
      if (feedErr) throw feedErr
      const rows = (feedRows ?? []) as { id: string; name: string; project_id: string }[]

      // The feed's market (country) for the flag. Lives in shop_settings today.
      const country = new Map<string, string | null>()
      if (rows.length) {
        const { data: settings, error: setErr } = await db
          .from('shop_settings')
          .select('feed_id, selected_country')
          .in('feed_id', rows.map((r) => r.id))
        if (setErr) throw setErr
        for (const s of (settings ?? []) as { feed_id: string; selected_country: string | null }[]) {
          country.set(s.feed_id, s.selected_country)
        }
      }
      feeds = rows.map((r) => ({
        id: r.id,
        name: r.name,
        projectId: r.project_id,
        country: country.get(r.id) ?? null,
      }))
    }

    const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string }
    const body: ShellData = {
      user: {
        email: user.email ?? '',
        name: meta.full_name || meta.name || user.email || '',
      },
      accounts: memberships.map((m) => ({
        id: m.account_id,
        name: accountName.get(m.account_id) ?? 'Konto',
        role: m.role,
      })),
      projects: projects.map((p) => ({
        id: p.id,
        accountId: p.account_id,
        name: p.name,
        shopUrl: p.source_type === 'feed_url' ? (p.primary_domain ?? null) : p.shop_url,
      })),
      feeds,
    }
    return NextResponse.json(body)
  } catch (err) {
    return errorResponse(err, 'GET /api/shell')
  }
}
