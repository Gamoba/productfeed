'use server'

import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { deleteMasterField, saveMasterField, type MasterFieldInput } from '@/lib/ops/masterFields'

type Result = { error?: string; warnings?: string[]; key?: string }

async function access(projectId: string) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return null
  return (await getOwnedProject(user.id, projectId)) ? user : null
}

export async function saveMasterFieldAction(projectId: string, input: MasterFieldInput): Promise<Result> {
  const user = await access(projectId)
  if (!user) return { error: 'Ikke tilladt' }
  return saveMasterField(adminDb(), { user }, projectId, input)
}

export async function deleteMasterFieldAction(projectId: string, key: string): Promise<Result> {
  const user = await access(projectId)
  if (!user) return { error: 'Ikke tilladt' }
  return deleteMasterField(adminDb(), { user }, projectId, key)
}
