import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getAgencyOverview } from '@/lib/agencyOverview'
import { completeSignup, hasPendingSignup } from '@/lib/signup'
import { getCurrentAccount } from '@/lib/currentAccount'
import { blocksApp, getEntitlements } from '@/lib/entitlements'
import { AgencyDashboardClient } from './agency/AgencyDashboardClient'

// Dashboard: every shop the account the user is working in can reach
// (lib/currentAccount.ts) — its own, and for an agency its clients' — in one
// table. Clicking a row opens the shop with its feeds.
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

  // The account has no usable plan (none yet, or it ended): Billing is the
  // only page. Another account can still be chosen in the switcher.
  const { current } = await getCurrentAccount(adminDb(), user.id)
  if (current) {
    const ent = await getEntitlements(adminDb(), current.id)
    if (ent && blocksApp(ent)) redirect('/billing')
  }

  const overview = current ? await getAgencyOverview(adminDb(), user.id, current.id) : { multipleAccounts: false, shops: [] }
  return <AgencyDashboardClient initial={overview} account={current ? { name: current.name, type: current.type } : null} />
}
