import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { ACTIVITY_LIMIT, getShopActivity } from '@/lib/activity'
import { ActivityClient } from './ActivityClient'

// Shop › Activity log. Who changed what in the shop, and when, with the value
// before and after. Account-wide events (users) show in every shop.
export default async function ActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  const { rows, available } = await getShopActivity(adminDb(), projectId, project.account_id)
  return <ActivityClient rows={rows} available={available} limit={ACTIVITY_LIMIT} />
}
