import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { mccAccountIdsOf } from '@/lib/mccAccess'
import { getPartnerOverview } from '@/lib/mcc'
import { getDefaultCommissionRate } from '@/lib/platformAdmin'
import { PartnerClient } from './PartnerClient'

// Agency › Partner levels (an agency's side): its referral link and what it
// earns on the clients it referred. ?agency picks the agency when the user
// belongs to several.
export default async function PartnerLevelsPage({ searchParams }: { searchParams: Promise<{ agency?: string }> }) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const db = adminDb()
  const mccIds = await mccAccountIdsOf(db, user.id)
  if (mccIds.length === 0) return <PartnerClient data={null} signupBase="" />
  const { agency } = await searchParams
  const mccId = mccIds.includes(agency ?? '') ? agency! : mccIds[0]
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https')
  const data = await getPartnerOverview(db, user.id, mccId, await getDefaultCommissionRate(db))
  return <PartnerClient data={data} signupBase={`${proto}://${host}/signup?ref=`} />
}
