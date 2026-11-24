'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { applyAdsSchedule, applyFeedMode, applyFeedSchedule } from '@/lib/ops/feedConfig'

// Thin wrappers: check the session and access, then the shared change in
// lib/ops/feedConfig (also used by the MCP tools).
async function access(feedId: string) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' } as const
  if (!(await getOwnedFeed(user.id, feedId))) return { error: 'Feed not found' } as const
  return { user }
}

export async function saveFeedMode(feedId: string, mode: 'product' | 'variant'): Promise<{ error?: string }> {
  const a = await access(feedId)
  if ('error' in a) return a
  return applyFeedMode(adminDb(), { user: a.user }, feedId, mode)
}

export async function saveAutoSyncSchedule(feedId: string, frequency: string, time: string): Promise<{ error?: string }> {
  const a = await access(feedId)
  if ('error' in a) return a
  return applyFeedSchedule(adminDb(), { user: a.user }, feedId, frequency, time)
}

export async function saveGoogleAdsSchedule(feedId: string, frequency: string, time: string): Promise<{ error?: string }> {
  const a = await access(feedId)
  if ('error' in a) return a
  return applyAdsSchedule(adminDb(), { user: a.user }, feedId, frequency, time)
}
