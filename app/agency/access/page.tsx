import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getMemberships } from '@/lib/accounts'
import { getClientAccess } from '@/lib/mcc'
import { AccessClient } from './AccessClient'

// Agency › Agency access (a customer's side): the account's access code,
// agencies asking for access, and agencies that have it. ?account picks the
// account when the user belongs to several customer accounts.
export default async function AgencyAccessPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const db = adminDb()
  const memberships = await getMemberships(db, user.id)
  const { data: accs } = memberships.length
    ? await db.from('accounts').select('id, name, type').in('id', memberships.map((m) => m.account_id))
    : { data: [] }
  const userAccounts = ((accs ?? []) as { id: string; name: string; type: string }[]).filter((a) => a.type === 'user')
  if (userAccounts.length === 0) {
    return <AccessClient data={null} accounts={[]} />
  }
  const { account } = await searchParams
  const accountId = userAccounts.find((a) => a.id === account)?.id ?? userAccounts[0].id
  const data = await getClientAccess(db, user.id, accountId)
  return <AccessClient data={data} accounts={userAccounts.map(({ id, name }) => ({ id, name }))} />
}
