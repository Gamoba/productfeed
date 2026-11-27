// Billing for SKUs above the plan (migration 066).
//
// Rules (docs/billing-brief.md §5, decisions 22 and 28):
//   - A month's extras are billed on the **highest daily total** in that
//     calendar month (lib/skuUsage.ts), above the plan's included SKUs plus
//     whatever the account's add-ons add.
//   - The price is the plan's rate per 1,000, rounded up to whole thousands.
//     On a yearly plan the rate is the annual one (× 10 / 12), since the base
//     is paid for 10 months and covers 12.
//   - No ceiling: any plan bills extras however far above the included count
//     (decision 28). The Billing page shows when another plan is cheaper.
//   - Monthly plans: the amount goes on the next invoice as a pending invoice
//     item, so the customer gets one invoice.
//   - Yearly plans: there is no monthly invoice, so a separate invoice is
//     created for the month and charged to the card on file.
//
// Each account is billed once per month and Stripe mode: the sku_charges row
// is claimed before Stripe is called, and released again if Stripe fails, so
// a retry can never bill twice.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import { stripe, stripeLivemode } from '@/lib/stripe'
import { addonLimitsFor } from '@/lib/addons'
import { accountMonthPeak, monthStart, nextMonthStart, previousMonthStart } from '@/lib/skuUsage'

// SaaS, business use — as scripts/stripe-setup.ts and lib/customPlans.ts.
const TAX_CODE = 'txcd_10103001'

export type ExtraSkuBasis = {
  accountId: string
  month: string
  planId: string
  planName: string
  interval: 'month' | 'year'
  /** The highest daily total measured in the month. */
  peakSkus: number
  /** Days the month was measured on; 0 means nothing to bill on yet. */
  measuredDays: number
  /** The plan's included SKUs plus what add-ons add. */
  includedSkus: number | null
  ratePer1000Cents: number | null
  extraThousands: number
  amountCents: number
  currency: string
}

type PlanRow = {
  id: string
  name: string
  included_skus: number | null
  extra_per_1000_cents: number | null
  plan_prices: { interval: 'month' | 'year'; livemode: boolean; currency: string }[]
}

type SubRow = {
  id: string
  account_id: string
  plan_id: string
  interval: 'month' | 'year'
  status: string
  stripe_subscription_id: string
  plans: PlanRow | null
}

const LIVE = ['active', 'trialing', 'past_due']

// The rate for one thousand extra SKUs on this plan and interval. Yearly pays
// for 10 months out of 12, so the monthly extras get the same discount.
export function ratePer1000(plan: { extraPer1000Cents: number | null }, interval: 'month' | 'year'): number | null {
  if (plan.extraPer1000Cents === null) return null
  return interval === 'year' ? (plan.extraPer1000Cents * 10) / 12 : plan.extraPer1000Cents
}

export function extraThousands(peak: number, included: number): number {
  return peak > included ? Math.ceil((peak - included) / 1000) : 0
}

async function liveSubscription(db: SupabaseClient, accountId: string): Promise<SubRow | null> {
  const { data, error } = await db
    .from('subscriptions')
    .select(
      'id, account_id, plan_id, interval, status, stripe_subscription_id, plans(id, name, included_skus, extra_per_1000_cents, plan_prices(interval, livemode, currency))'
    )
    .eq('account_id', accountId)
    .eq('kind', 'plan')
    .eq('livemode', stripeLivemode())
    .order('updated_at', { ascending: false })
  if (error) dbError('liveSubscription', error)
  return (((data ?? []) as unknown as SubRow[]).find((s) => LIVE.includes(s.status)) ?? null)
}

// What a month's extras come to for one account. No Stripe calls, no writes:
// used by the Billing page (for the month running) and by the charge below.
export async function extraSkuBasis(db: SupabaseClient, accountId: string, month: string): Promise<ExtraSkuBasis | null> {
  const sub = await liveSubscription(db, accountId)
  if (!sub?.plans) return null
  const plan = sub.plans
  const livemode = stripeLivemode()
  const currency = plan.plan_prices?.find((p) => p.interval === sub.interval && p.livemode === livemode)?.currency ?? 'eur'

  const [{ peak, days }, addons] = await Promise.all([
    accountMonthPeak(db, accountId, month),
    addonLimitsFor(db, accountId),
  ])
  const included = plan.included_skus === null ? null : plan.included_skus + addons.skuDelta
  const rate = ratePer1000({ extraPer1000Cents: plan.extra_per_1000_cents }, sub.interval)
  const thousands = included === null || rate === null ? 0 : extraThousands(peak, included)

  return {
    accountId,
    month,
    planId: plan.id,
    planName: plan.name,
    interval: sub.interval,
    peakSkus: peak,
    measuredDays: days,
    includedSkus: included,
    ratePer1000Cents: rate === null ? null : Math.round(rate),
    extraThousands: thousands,
    amountCents: rate === null ? 0 : Math.round(thousands * rate),
    currency,
  }
}

export type SkuCharge = {
  accountId: string
  month: string
  status: 'charged' | 'none' | 'already' | 'skipped'
  amountCents: number
  currency: string
  peakSkus: number
  includedSkus: number | null
  note?: string
  stripeInvoiceId?: string | null
}

const monthLabel = (month: string) =>
  new Date(`${month}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

const unix = (date: string) => Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000)

// Bills one account for one finished month. Safe to call again: the second
// call answers 'already'.
export async function chargeExtraSkusFor(
  db: SupabaseClient,
  accountId: string,
  month: string,
  opts: { dryRun?: boolean } = {}
): Promise<SkuCharge> {
  const livemode = stripeLivemode()
  const basis = await extraSkuBasis(db, accountId, month)
  const none = (status: SkuCharge['status'], note?: string): SkuCharge => ({
    accountId,
    month,
    status,
    amountCents: 0,
    currency: basis?.currency ?? 'eur',
    peakSkus: basis?.peakSkus ?? 0,
    includedSkus: basis?.includedSkus ?? null,
    note,
  })
  if (!basis) return none('skipped', 'no live plan')

  // Already settled for this month?
  const { data: existing, error: eErr } = await db
    .from('sku_charges')
    .select('status, amount_cents, currency, stripe_invoice_id')
    .eq('account_id', accountId)
    .eq('period_month', month)
    .eq('livemode', livemode)
    .maybeSingle<{ status: string; amount_cents: number; currency: string; stripe_invoice_id: string | null }>()
  if (eErr) dbError('chargeExtraSkusFor existing', eErr)
  if (existing) {
    return {
      ...none('already'),
      amountCents: existing.amount_cents,
      currency: existing.currency,
      stripeInvoiceId: existing.stripe_invoice_id,
    }
  }

  // Nothing measured: don't record anything, so a later run can still bill it.
  if (basis.measuredDays === 0) return none('skipped', 'no SKUs measured that month')
  if (basis.includedSkus === null || basis.ratePer1000Cents === null) {
    // A plan with no extra-SKU rate (Enterprise, a custom plan by agreement).
    if (!opts.dryRun) await record(db, basis, 'none', 0, {})
    return none('none', 'the plan bills no extra SKUs')
  }
  if (basis.extraThousands === 0) {
    if (!opts.dryRun) await record(db, basis, 'none', 0, {})
    return { ...none('none'), peakSkus: basis.peakSkus, includedSkus: basis.includedSkus }
  }
  if (opts.dryRun) {
    return {
      accountId,
      month,
      status: 'charged',
      amountCents: basis.amountCents,
      currency: basis.currency,
      peakSkus: basis.peakSkus,
      includedSkus: basis.includedSkus,
      note: 'dry run: nothing sent to Stripe',
    }
  }

  const { data: cust, error: cErr } = await db
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('account_id', accountId)
    .eq('livemode', livemode)
    .maybeSingle<{ stripe_customer_id: string }>()
  if (cErr) dbError('chargeExtraSkusFor customer', cErr)
  if (!cust) return none('skipped', 'the account has no Stripe customer')

  const sub = await liveSubscription(db, accountId)
  if (!sub) return none('skipped', 'no live plan')

  // Claim the month before calling Stripe: a crash afterwards can then only
  // lose the invoice ids, never bill twice.
  const claimed = await record(db, basis, 'charged', basis.amountCents, {})
  if (!claimed) return { ...none('already'), amountCents: basis.amountCents }

  const description = `Extra SKUs ${monthLabel(month)} — ${basis.extraThousands.toLocaleString('en-GB')} × 1,000 above ${basis.includedSkus.toLocaleString('en-GB')} included (peak ${basis.peakSkus.toLocaleString('en-GB')})`
  const period = { start: unix(month), end: unix(nextMonthStart(month)) - 1 }
  const metadata = { account_id: accountId, period_month: month, peak_skus: String(basis.peakSkus) }

  try {
    const item = await stripe().invoiceItems.create(
      {
        customer: cust.stripe_customer_id,
        amount: basis.amountCents,
        currency: basis.currency,
        description,
        period,
        tax_behavior: 'exclusive',
        tax_code: TAX_CODE,
        metadata,
        // A monthly plan has an invoice coming: the item rides along on it.
        ...(basis.interval === 'month' ? { subscription: sub.stripe_subscription_id } : {}),
      },
      { idempotencyKey: `skus-${accountId}-${month}-${livemode ? 'live' : 'test'}` }
    )

    let invoiceId: string | null = null
    if (basis.interval === 'year') {
      // Nothing else is due this month, so the extras get their own invoice,
      // charged to the card on file.
      //
      // Which card: Checkout puts it on the subscription, not in the
      // customer's invoice settings, and an invoice of our own doesn't
      // inherit it. Without it Stripe finalises the invoice and then can't
      // collect ("no default_payment_method set on this Customer or
      // Invoice"), so it is passed explicitly.
      const paymentMethod = await subscriptionPaymentMethod(sub.stripe_subscription_id)
      const invoice = await stripe().invoices.create(
        {
          customer: cust.stripe_customer_id,
          collection_method: 'charge_automatically',
          automatic_tax: { enabled: true },
          // Takes the item above onto this invoice instead of the next one.
          pending_invoice_items_behavior: 'include',
          auto_advance: true,
          description: `Extra SKUs for ${monthLabel(month)}`,
          ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
          metadata,
        },
        { idempotencyKey: `skus-inv-${accountId}-${month}-${livemode ? 'live' : 'test'}` }
      )
      invoiceId = invoice.id ?? null
      if (invoice.id) await stripe().invoices.finalizeInvoice(invoice.id, { auto_advance: true })
    }

    const { error } = await db
      .from('sku_charges')
      .update({ stripe_invoice_item_id: item.id, stripe_invoice_id: invoiceId })
      .eq('account_id', accountId)
      .eq('period_month', month)
      .eq('livemode', livemode)
    if (error) dbError('chargeExtraSkusFor ids', error)

    return {
      accountId,
      month,
      status: 'charged',
      amountCents: basis.amountCents,
      currency: basis.currency,
      peakSkus: basis.peakSkus,
      includedSkus: basis.includedSkus,
      stripeInvoiceId: invoiceId,
    }
  } catch (err) {
    // Hand the month back so the next run tries again.
    await db
      .from('sku_charges')
      .delete()
      .eq('account_id', accountId)
      .eq('period_month', month)
      .eq('livemode', livemode)
      .is('stripe_invoice_item_id', null)
    console.error('[extraSkus] charging failed for', accountId, month, err)
    return none('skipped', err instanceof Error ? err.message : 'Stripe refused the charge')
  }
}

// The card the plan is paid with, for an invoice that stands on its own.
// Falls back to the customer's own default, and to nothing — Stripe then
// finalises the invoice and duns the customer for it.
async function subscriptionPaymentMethod(stripeSubscriptionId: string): Promise<string | null> {
  try {
    const sub = await stripe().subscriptions.retrieve(stripeSubscriptionId)
    const pm = sub.default_payment_method
    if (pm) return typeof pm === 'string' ? pm : pm.id
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
    const customer = await stripe().customers.retrieve(customerId)
    if ('deleted' in customer) return null
    const fallback = customer.invoice_settings?.default_payment_method
    return fallback ? (typeof fallback === 'string' ? fallback : fallback.id) : null
  } catch (err) {
    console.error('[extraSkus] could not read the subscription’s payment method:', err)
    return null
  }
}

async function record(
  db: SupabaseClient,
  basis: ExtraSkuBasis,
  status: 'charged' | 'none',
  amountCents: number,
  ids: { itemId?: string; invoiceId?: string }
): Promise<boolean> {
  const { error } = await db.from('sku_charges').insert({
    account_id: basis.accountId,
    period_month: basis.month,
    plan_id: basis.planId,
    interval: basis.interval,
    peak_skus: basis.peakSkus,
    included_skus: basis.includedSkus ?? 0,
    extra_thousands: status === 'charged' ? basis.extraThousands : 0,
    rate_per_1000_cents: basis.ratePer1000Cents ?? 0,
    amount_cents: amountCents,
    currency: basis.currency,
    stripe_invoice_item_id: ids.itemId ?? null,
    stripe_invoice_id: ids.invoiceId ?? null,
    status,
    livemode: stripeLivemode(),
  })
  // Another run claimed the month first.
  if (error?.code === '23505') return false
  if (error) dbError('extraSkus record', error)
  return true
}

// Bills every paying account for the month that has just ended. Called by the
// daily cron: on the first run after a month ends it charges, and on later
// runs each account answers 'already'.
export async function chargeExtraSkus(
  db: SupabaseClient,
  opts: { month?: string; dryRun?: boolean } = {}
): Promise<SkuCharge[]> {
  const month = opts.month ?? previousMonthStart(new Date())
  // Never bill a month that hasn't finished.
  if (month >= monthStart(new Date())) return []

  const { data, error } = await db
    .from('subscriptions')
    .select('account_id, status, accounts!inner(billing_exempt)')
    .eq('kind', 'plan')
    .eq('livemode', stripeLivemode())
    .in('status', LIVE)
  if (error) dbError('chargeExtraSkus accounts', error)
  const accountIds = [
    ...new Set(
      ((data ?? []) as unknown as { account_id: string; accounts: { billing_exempt: boolean } | null }[])
        .filter((r) => !r.accounts?.billing_exempt)
        .map((r) => r.account_id)
    ),
  ]

  const out: SkuCharge[] = []
  for (const accountId of accountIds) {
    out.push(await chargeExtraSkusFor(db, accountId, month, opts))
  }
  return out
}

export type SkuChargeRow = {
  month: string
  status: string
  amountCents: number
  currency: string
  peakSkus: number
  includedSkus: number
  extraThousands: number
}

/** The last few months' extra-SKU charges, for the Billing page. */
export async function recentSkuCharges(db: SupabaseClient, accountId: string, limit = 6): Promise<SkuChargeRow[]> {
  const { data, error } = await db
    .from('sku_charges')
    .select('period_month, status, amount_cents, currency, peak_skus, included_skus, extra_thousands')
    .eq('account_id', accountId)
    .eq('livemode', stripeLivemode())
    .order('period_month', { ascending: false })
    .limit(limit)
  if (error) dbError('recentSkuCharges', error)
  return ((data ?? []) as {
    period_month: string
    status: string
    amount_cents: number
    currency: string
    peak_skus: number
    included_skus: number
    extra_thousands: number
  }[]).map((r) => ({
    month: r.period_month,
    status: r.status,
    amountCents: r.amount_cents,
    currency: r.currency,
    peakSkus: r.peak_skus,
    includedSkus: r.included_skus,
    extraThousands: r.extra_thousands,
  }))
}
