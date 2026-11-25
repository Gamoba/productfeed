import { headers } from 'next/headers'
import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { getAccountRole } from '@/lib/accounts'
import { listChanges } from '@/lib/mcp/changes'
import { MCP_PATH } from '@/lib/mcp/auth'
import { McpClient, type McpState } from './McpClient'

// Shop › API / MCP. Connecting Claude (or another MCP client) to FeedFlow,
// approving the changes it asks for, and the agency's "apply without
// approval" setting. The connection itself is per user and reaches every shop
// in the agency; the change list here is this shop's.
export default async function ApiMcpPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  const db = adminDb()
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')

  const [{ data: account }, role, pending, recent, grants] = await Promise.all([
    // select('*') so the page renders before migration 057 (no mcp_auto_apply).
    db.from('accounts').select('*').eq('id', project.account_id).maybeSingle(),
    getAccountRole(db, user.id, project.account_id),
    listChanges(db, { projectIds: [projectId], status: 'pending', limit: 100 }),
    listChanges(db, { projectIds: [projectId], limit: 30 }),
    supabase.auth.oauth.listGrants().catch(() => ({ data: null, error: true })),
  ])
  const acc = (account ?? {}) as { name?: string; mcp_auto_apply?: boolean }

  const state: McpState = {
    projectId,
    endpoint: `${proto}://${host}${MCP_PATH}`,
    agencyName: acc.name ?? 'your agency',
    autoApply: !!acc.mcp_auto_apply,
    canChangeSetting: role === 'owner' || role === 'admin',
    pending,
    history: recent.filter((c) => c.status !== 'pending'),
    // null = the OAuth server isn't switched on in Supabase yet.
    grants: grants.error || !grants.data
      ? null
      : grants.data.map((g) => ({ clientId: g.client.id, name: g.client.name || 'Unnamed app', grantedAt: g.granted_at })),
  }

  return <McpClient initial={state} />
}
