'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { getAccountRole } from '@/lib/accounts'
import { logActivity } from '@/lib/activity'
import { AppError, clientMessage } from '@/lib/errors'
import { decideChange, type ChangeStatus } from '@/lib/mcp/changes'

async function sessionUser() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return { supabase, user }
}

// Approve or reject a change Claude asked for. Any member of the shop's agency
// may: they could make the same change by hand.
export async function decideMcpChange(
  projectId: string,
  changeId: number,
  approve: boolean
): Promise<{ status?: ChangeStatus; error?: string }> {
  const { user } = await sessionUser()
  if (!user) return { error: 'Unauthorized' }
  if (!(await getOwnedProject(user.id, projectId))) return { error: 'Shop not found' }

  const db = adminDb()
  const { data: row } = await db.from('mcp_changes').select('project_id').eq('id', changeId).maybeSingle()
  if ((row as { project_id?: string } | null)?.project_id !== projectId) return { error: 'Change not found' }
  try {
    const r = await decideChange(db, user, changeId, approve)
    return r.error ? { status: r.status, error: r.error } : { status: r.status }
  } catch (err) {
    return { error: err instanceof AppError ? err.message : clientMessage(err, 'decideMcpChange') }
  }
}

// "Apply changes from assistants without approval". Agency-wide; owners and
// admins only.
export async function setMcpAutoApply(projectId: string, on: boolean): Promise<{ error?: string }> {
  const { user } = await sessionUser()
  if (!user) return { error: 'Unauthorized' }
  const project = await getOwnedProject(user.id, projectId)
  if (!project) return { error: 'Shop not found' }

  const db = adminDb()
  const role = await getAccountRole(db, user.id, project.account_id)
  if (role !== 'owner' && role !== 'admin') return { error: 'Only owners and admins can change this' }

  const { error } = await db.from('accounts').update({ mcp_auto_apply: on }).eq('id', project.account_id)
  if (error) return { error: clientMessage(error, 'setMcpAutoApply') }
  await logActivity(db, {
    user,
    accountId: project.account_id,
    area: 'API / MCP',
    action: on ? 'Changes from assistants now apply without approval' : 'Changes from assistants now need approval',
  })
  return {}
}

// Disconnects an assistant from the signed-in user's login: its tokens stop
// working at once. Other people's connections are their own.
export async function disconnectAssistant(clientId: string): Promise<{ error?: string }> {
  const { supabase, user } = await sessionUser()
  if (!user) return { error: 'Unauthorized' }
  const { error } = await supabase.auth.oauth.revokeGrant({ clientId })
  if (error) return { error: 'Could not disconnect. Try again.' }
  return {}
}
