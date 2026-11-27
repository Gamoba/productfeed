import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getMemberships } from '@/lib/accounts'
import { canManageBilling, getAccountBilling, getBillingDetail, listPlansForAccount, syncCheckoutSession } from '@/lib/billing'
import { billingConfigured } from '@/lib/stripe'
import { BillingClient } from './BillingClient'

type Search = { account?: string; checkout?: string }

// Billing for one account (agency level). ?account picks which, when the
// user belongs to several; otherwise their first membership, as elsewhere at
// this level. ?checkout is Stripe's session id on return from Checkout.
export default async function BillingPage({ searchParams }: { searchParams: Promise<Search> }) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const db = adminDb()
  const memberships = await getMemberships(db, user.id)
  if (memberships.length === 0) redirect('/')

  const { account, checkout } = await searchParams
  const accountId = memberships.find((m) => m.account_id === account)?.account_id ?? memberships[0].account_id

  let checkoutNote: 'done' | 'pending' | null = null
  if (checkout && billingConfigured()) {
    try {
      await syncCheckoutSession(db, accountId, checkout)
    } catch (err) {
      console.error('[billing] checkout return sync:', err)
    }
  }

  const [billing, plans, canManage, detail, accounts] = await Promise.all([
    getAccountBilling(db, accountId),
    listPlansForAccount(db, accountId),
    canManageBilling(db, user.id, accountId),
    getBillingDetail(db, accountId),
    memberships.length > 1
      ? db
          .from('accounts')
          .select('id, name')
          .in('id', memberships.map((m) => m.account_id))
          .then(({ data }) => (data ?? []) as { id: string; name: string }[])
      : Promise.resolve([]),
  ])
  if (checkout) checkoutNote = billing.subscription ? 'done' : 'pending'

  return (
    <BillingClient
      billing={billing}
      plans={plans}
      canManage={canManage}
      configured={billingConfigured()}
      accounts={accounts}
      detail={detail}
      checkoutNote={checkoutNote}
    />
  )
}
