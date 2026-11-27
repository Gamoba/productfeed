import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getAgencyMonitoring } from '@/lib/agencyMonitoring'
import { getCurrentAccount } from '@/lib/currentAccount'
import { MonitoringClient } from './MonitoringClient'

// Agency › Monitoring: feed quality per customer and what needs someone to act,
// across every shop the account the user is working in reaches
// (lib/agencyMonitoring, lib/currentAccount). Read-only.
export default async function MonitoringPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const db = adminDb()
  const { current } = await getCurrentAccount(db, user.id)
  // No account at all: an empty page (the scope must never fall back to "all").
  const data = await getAgencyMonitoring(db, user.id, current?.id ?? '')
  return <MonitoringClient data={data} />
}
