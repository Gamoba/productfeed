'use server'

import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { applyMappings, type MappingEntry as OpsMappingEntry } from '@/lib/ops/feedConfig'

// Plain type alias, not `export type { … }`: a re-export in a 'use server'
// file is compiled as a value export and fails at runtime.
export type MappingEntry = OpsMappingEntry

// Checks the session and access; the change itself is shared with the MCP
// tools (lib/ops/feedConfig).
export async function saveMappings(
  feedId: string,
  entries: MappingEntry[]
): Promise<{ error?: string; warnings?: string[] }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed ikke fundet' }

  return applyMappings(adminDb(), { user }, feedId, entries)
}
