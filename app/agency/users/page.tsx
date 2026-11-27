import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getCurrentAccount } from '@/lib/currentAccount'
import { listAccountUsers } from '@/lib/accountMembers'
import { UsersClient } from './UsersClient'

// Users: who can reach the account the user is working in
// (lib/currentAccount.ts), the one the sidebar shows.
export default async function AgencyUsersPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const db = adminDb()
  const { current } = await getCurrentAccount(db, user.id)
  if (!current) redirect('/')

  const data = await listAccountUsers(db, user.id, current.id)
  return <UsersClient initial={data} />
}
