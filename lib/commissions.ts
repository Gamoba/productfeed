// Agency kickbacks (docs/billing-data-model.md, decisions 5–7, 15–16, 25–27).
//
//   - Only the agency (MCC) whose referral link the client signed up through
//     earns, for as long as the client pays, on each paid invoice excl. VAT.
//   - The rate is copied onto the referral at signup.
//   - A monthly invoice gives one part, due on the last day of the month it
//     was paid. A yearly invoice gives 12 parts of one twelfth each, due on
//     the last day of each of the 12 months from the payment month.
//   - A refund reduces (or drops) parts not paid out yet; for parts already
//     paid out it adds a negative 'reversed' row, deducted from the next payout.
//   - Cancelling the plan, or the client revoking the agency's access, drops
//     the parts not yet due.
//   - A referral earns while 'active', or when a platform admin has switched
//     its kickback back on (kickback_override).
//
// Written from the Stripe webhook (lib/billing.ts), so every function is safe
// to run twice for the same event.

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'

type Referral = {
  id: string
  status: 'pending' | 'active' | 'stopped'
  commission_rate: number | string
  kickback_override: boolean
}

// Last day of the month `offset` months after `d` (UTC), as YYYY-MM-DD.
function monthEnd(d: Date, offset = 0): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0)).toISOString().slice(0, 10)
}
const today = () => new Date().toISOString().slice(0, 10)

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const ref = invoice.parent?.subscription_details?.subscription
  return typeof ref === 'string' ? ref : (ref?.id ?? null)
}

// A paid invoice: start the referral on its first payment, then write the
// invoice's commission parts (once).
export async function recordPaidInvoice(db: SupabaseClient, invoice: Stripe.Invoice): Promise<void> {
  if (invoice.amount_paid <= 0) return
  const stripeSubId = invoiceSubscriptionId(invoice)
  if (!stripeSubId || !invoice.id) return

  const { data: sub, error: sErr } = await db
    .from('subscriptions')
    .select('id, account_id, interval')
    .eq('stripe_subscription_id', stripeSubId)
    .eq('kind', 'plan')
    .maybeSingle<{ id: string; account_id: string; interval: 'month' | 'year' }>()
  if (sErr) dbError('recordPaidInvoice subscription', sErr)
  if (!sub) return

  const { data: ref, error: rErr } = await db
    .from('referrals')
    .select('id, status, commission_rate, kickback_override')
    .eq('user_account_id', sub.account_id)
    .maybeSingle<Referral>()
  if (rErr) dbError('recordPaidInvoice referral', rErr)
  if (!ref) return

  const paidAt = new Date((invoice.status_transitions?.paid_at ?? Math.floor(Date.now() / 1000)) * 1000)
  if (ref.status === 'pending') {
    const { error } = await db
      .from('referrals')
      .update({ status: 'active', first_paid_at: paidAt.toISOString() })
      .eq('id', ref.id)
      .eq('status', 'pending')
    if (error) dbError('recordPaidInvoice activate', error)
    ref.status = 'active'
  }
  if (ref.status !== 'active' && !ref.kickback_override) return

  // Once per invoice (a replayed webhook finds the parts already there).
  const { count, error: cErr } = await db
    .from('commissions')
    .select('id', { count: 'exact', head: true })
    .eq('stripe_invoice_id', invoice.id)
    .neq('status', 'reversed')
  if (cErr) dbError('recordPaidInvoice existing', cErr)
  if ((count ?? 0) > 0) return

  const base = invoice.total_excluding_tax ?? invoice.subtotal_excluding_tax ?? invoice.subtotal
  if (!base || base <= 0) return
  const rate = Number(ref.commission_rate)
  const parts = sub.interval === 'year' ? 12 : 1
  const each = Math.floor(base / parts)
  // The commission is rounded once, on the whole invoice, and split the same
  // way, so the parts add up to exactly rate × invoice.
  const totalCommission = Math.round(base * rate)
  const eachCommission = Math.floor(totalCommission / parts)
  const rows = Array.from({ length: parts }, (_, i) => {
    // The last part takes the cents the division left over.
    const last = i === parts - 1
    const amount = last ? base - each * (parts - 1) : each
    return {
      referral_id: ref.id,
      subscription_id: sub.id,
      stripe_invoice_id: invoice.id,
      installment: i + 1,
      invoice_amount_cents: amount,
      rate,
      commission_cents: last ? totalCommission - eachCommission * (parts - 1) : eachCommission,
      currency: invoice.currency,
      payable_on: monthEnd(paidAt, i),
      status: 'scheduled',
      livemode: invoice.livemode,
    }
  })
  const { error } = await db.from('commissions').insert(rows)
  if (error && error.code !== '23505') dbError('recordPaidInvoice insert', error)
}

// A refund (credit note) on an invoice: scale its commission down by the
// share refunded.
export async function recordCreditNote(db: SupabaseClient, note: Stripe.CreditNote, invoiceTotal: number): Promise<void> {
  const invoiceId = typeof note.invoice === 'string' ? note.invoice : note.invoice?.id
  if (!invoiceId || invoiceTotal <= 0) return
  const share = Math.min(1, note.total / invoiceTotal)
  if (share <= 0) return

  // Reversal rows carry the credit note in stripe_invoice_id. The webhook
  // handles each Stripe event once (stripe_events), so this runs once per note.
  const marker = `${invoiceId}#${note.id}`

  const { data, error } = await db
    .from('commissions')
    .select('id, referral_id, subscription_id, installment, invoice_amount_cents, rate, commission_cents, currency, payout_id, livemode')
    .eq('stripe_invoice_id', invoiceId)
    .eq('status', 'scheduled')
  if (error) dbError('recordCreditNote parts', error)
  type Part = {
    id: string; referral_id: string; subscription_id: string | null; installment: number; invoice_amount_cents: number
    rate: number; commission_cents: number; currency: string; payout_id: string | null; livemode: boolean
  }
  const reversals: Record<string, unknown>[] = []
  for (const p of (data ?? []) as Part[]) {
    const cut = Math.round(p.commission_cents * share)
    if (cut === 0) continue
    if (p.payout_id) {
      reversals.push({
        referral_id: p.referral_id,
        subscription_id: p.subscription_id,
        stripe_invoice_id: marker,
        installment: p.installment,
        invoice_amount_cents: -Math.round(p.invoice_amount_cents * share),
        rate: p.rate,
        commission_cents: -cut,
        currency: p.currency,
        payable_on: today(),
        status: 'reversed',
        livemode: p.livemode,
      })
    } else if (share >= 0.999) {
      const { error: e } = await db.from('commissions').update({ status: 'dropped' }).eq('id', p.id)
      if (e) dbError('recordCreditNote drop', e)
    } else {
      const { error: e } = await db
        .from('commissions')
        .update({ commission_cents: p.commission_cents - cut })
        .eq('id', p.id)
      if (e) dbError('recordCreditNote reduce', e)
    }
  }
  if (reversals.length) {
    const { error: e } = await db.from('commissions').insert(reversals)
    if (e) dbError('recordCreditNote reversals', e)
  }
}

// Parts not due yet (and not paid out) are dropped: the plan was cancelled
// (by subscription) or the client revoked the agency's access (by referral).
export async function dropFutureParts(db: SupabaseClient, by: { subscriptionId?: string; referralId?: string }): Promise<void> {
  let q = db
    .from('commissions')
    .update({ status: 'dropped' })
    .eq('status', 'scheduled')
    .is('payout_id', null)
    .gt('payable_on', today())
  if (by.subscriptionId) q = q.eq('subscription_id', by.subscriptionId)
  else if (by.referralId) q = q.eq('referral_id', by.referralId)
  else return
  const { error } = await q
  if (error) dbError('dropFutureParts', error)
}

// ── Payouts (platform admin) ──────────────────────────────────────────────

export type PayoutDue = { mccAccountId: string; mccName: string; currency: string; dueCents: number; parts: number }

// What each agency is owed today: scheduled and reversed parts due by now and
// not yet paid out, summed per agency and currency.
export async function payoutsDue(db: SupabaseClient): Promise<PayoutDue[]> {
  const { data, error } = await db
    .from('commissions')
    .select('commission_cents, currency, status, referrals!inner(mcc_account_id, accounts!referrals_mcc_account_id_fkey(name))')
    .is('payout_id', null)
    .in('status', ['scheduled', 'reversed'])
    .lte('payable_on', today())
  if (error) dbError('payoutsDue', error)
  const sums = new Map<string, PayoutDue>()
  for (const r of (data ?? []) as unknown as {
    commission_cents: number
    currency: string
    referrals: { mcc_account_id: string; accounts: { name: string } | null }
  }[]) {
    const key = `${r.referrals.mcc_account_id}:${r.currency}`
    const s = sums.get(key) ?? {
      mccAccountId: r.referrals.mcc_account_id,
      mccName: r.referrals.accounts?.name ?? '—',
      currency: r.currency,
      dueCents: 0,
      parts: 0,
    }
    s.dueCents += r.commission_cents
    s.parts += 1
    sums.set(key, s)
  }
  // Only what's actually owed: a negative balance (a refund after payout)
  // waits and is deducted from the agency's next payout (decision 15).
  return [...sums.values()].filter((s) => s.dueCents > 0).sort((a, b) => b.dueCents - a.dueCents)
}

// Records that Gamoba has paid an agency what's due today (one currency), and
// links those parts to the payout.
export async function markPayoutPaid(
  db: SupabaseClient,
  adminId: string,
  mccAccountId: string,
  currency: string,
  reference: string | null
): Promise<{ totalCents: number }> {
  const { data, error } = await db
    .from('commissions')
    .select('id, commission_cents, referrals!inner(mcc_account_id)')
    .is('payout_id', null)
    .in('status', ['scheduled', 'reversed'])
    .eq('currency', currency)
    .eq('referrals.mcc_account_id', mccAccountId)
    .lte('payable_on', today())
  if (error) dbError('markPayoutPaid parts', error)
  const parts = (data ?? []) as { id: string; commission_cents: number }[]
  if (!parts.length) return { totalCents: 0 }
  const total = parts.reduce((n, p) => n + p.commission_cents, 0)
  const { data: payout, error: pErr } = await db
    .from('commission_payouts')
    .insert({
      mcc_account_id: mccAccountId,
      period_month: monthEnd(new Date()).slice(0, 8) + '01',
      total_cents: total,
      currency,
      reference,
      marked_paid_by: adminId,
    })
    .select('id')
    .single<{ id: string }>()
  if (pErr) dbError('markPayoutPaid payout', pErr)
  const { error: lErr } = await db.from('commissions').update({ payout_id: payout!.id }).in('id', parts.map((p) => p.id))
  if (lErr) dbError('markPayoutPaid link', lErr)
  return { totalCents: total }
}
