import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getAgencyMonitoring } from '@/lib/agencyMonitoring'
import { MonitoringClient } from './MonitoringClient'

// Agency › Monitoring: feed quality per customer and what needs someone to act,
// across every shop the user can reach (lib/agencyMonitoring). Read-only.
export default async function MonitoringPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const data = await getAgencyMonitoring(adminDb(), user.id)
  return <MonitoringClient data={data} />
}
