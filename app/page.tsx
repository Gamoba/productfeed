import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getAgencyOverview } from '@/lib/agencyOverview'
import { AgencyDashboardClient } from './agency/AgencyDashboardClient'

// Agency dashboard: every shop (customer) the user's accounts can reach, in
// one table. Clicking a row opens the shop with its feeds.
export default async function HomePage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)

  if (!user) redirect('/login')

  const overview = await getAgencyOverview(adminDb(), user.id)
  return <AgencyDashboardClient initial={overview} />
}
