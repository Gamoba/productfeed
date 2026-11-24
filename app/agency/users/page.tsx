import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getMemberships } from '@/lib/accounts'
import { listAccountUsers } from '@/lib/accountMembers'
import { UsersClient } from './UsersClient'

// Agency › Agency users. Who in the agency can reach its shops. The account is
// the user's first membership, the same one the shell shows at this level.
export default async function AgencyUsersPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const db = adminDb()
  const [first] = await getMemberships(db, user.id)
  if (!first) redirect('/')

  const data = await listAccountUsers(db, user.id, first.account_id)
  return <UsersClient initial={data} />
}
