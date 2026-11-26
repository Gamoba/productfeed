import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getAgencyOverview } from '@/lib/agencyOverview'
import { completeSignup, hasPendingSignup } from '@/lib/signup'
import { getMemberships } from '@/lib/accounts'
import { blocksApp, getEntitlementsMany } from '@/lib/entitlements'
import { AgencyDashboardClient } from './agency/AgencyDashboardClient'

// Agency dashboard: every shop (customer) the user's accounts can reach, in
// one table. Clicking a row opens the shop with its feeds.
export default async function HomePage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)

  if (!user) redirect('/login')

  // A signup whose last step failed (lib/signup.ts): finish it now.
  if (hasPendingSignup(user)) {
    const next = await completeSignup(adminDb(), user.id)
    if (next) redirect(next)
  }

  // No usable account (no plan yet, or it ended): Billing is the only page.
  const memberships = await getMemberships(adminDb(), user.id)
  if (memberships.length) {
    const ents = await getEntitlementsMany(adminDb(), memberships.map((m) => m.account_id))
    if ([...ents.values()].every(blocksApp)) redirect('/billing')
  }

  const overview = await getAgencyOverview(adminDb(), user.id)
  return <AgencyDashboardClient initial={overview} />
}
