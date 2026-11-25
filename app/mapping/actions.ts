'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { applyMappings, type MappingEntry } from '@/lib/ops/feedConfig'

export type { MappingEntry }

// Checks the session and access; the change itself is shared with the MCP
// tools (lib/ops/feedConfig).
export async function saveMappings(
  feedId: string,
  entries: MappingEntry[]
): Promise<{ error?: string; warnings?: string[] }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed not found' }

  return applyMappings(adminDb(), { user }, feedId, entries)
}
