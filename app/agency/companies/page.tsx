import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { mccAccountIdsOf } from '@/lib/mccAccess'
import { currentAccountPreference } from '@/lib/currentAccount'
import { getAgencyClients } from '@/lib/mcc'
import { CompaniesClient } from './CompaniesClient'

// Agency › Connected companies (an agency's side): its clients, requests it
// has sent, and where it enters a client's access code. The agency is the
// account the user is working in (lib/currentAccount.ts); ?agency overrides it.
export default async function ConnectedCompaniesPage({ searchParams }: { searchParams: Promise<{ agency?: string }> }) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const db = adminDb()
  const mccIds = await mccAccountIdsOf(db, user.id)
  if (mccIds.length === 0) return <CompaniesClient data={null} />
  const { agency } = await searchParams
  const current = await currentAccountPreference()
  const mccId = mccIds.includes(agency ?? '') ? agency! : mccIds.includes(current ?? '') ? current! : mccIds[0]
  return <CompaniesClient data={await getAgencyClients(db, user.id, mccId)} />
}
