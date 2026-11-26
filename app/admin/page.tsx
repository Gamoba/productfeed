import { notFound, redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getDefaultCommissionRate, isPlatformAdmin } from '@/lib/platformAdmin'
import { getAdminOverview } from '@/lib/mcc'
import { payoutsDue } from '@/lib/commissions'
import { emailConfigured } from '@/lib/email'
import { listCustomPlans } from '@/lib/customPlans'
import { AdminClient } from './AdminClient'

// Admin (Gamoba staff only): agency invites, commission rates, kickback
// overrides and payouts. Anyone else gets a 404.
export default async function AdminPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')
  const db = adminDb()
  if (!(await isPlatformAdmin(db, user.id))) notFound()

  const [overview, defaultRate, due, custom] = await Promise.all([
    getAdminOverview(db, user.id),
    getDefaultCommissionRate(db),
    payoutsDue(db),
    listCustomPlans(db, user.id),
  ])
  return <AdminClient overview={overview} defaultRate={defaultRate} due={due} emailReady={emailConfigured()} custom={custom} />
}
