// Billing: plans, subscriptions and the Stripe Checkout / portal / webhook
// logic (migration 061, docs/billing-data-model.md).
//
// Rules:
//   - Only `user` accounts that aren't billing_exempt need a subscription.
//     MCC accounts may subscribe too, to own shops of their own.
//   - Owners and admins manage billing; members can see it.
//   - Every Stripe-backed row carries livemode. Reads and webhook writes only
//     touch rows that match the key in use.
//   - This version sells the base plan only. Extra SKUs come once the SKU
//     counting rule is settled.
//
// Takes the service-role client; callers check the session user first.

import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { getAccountRole } from '@/lib/accounts'
import { stripe, stripeLivemode } from '@/lib/stripe'
import { dropFutureParts, recordCreditNote, recordPaidInvoice } from '@/lib/commissions'
import { accountAddons, listAddons, reconcileAddonItems, type Addon, type AccountAddon } from '@/lib/addons'
import {
  extraSkuBasis,
  extraThousands,
  ratePer1000,
  recentSkuCharges,
  type ExtraSkuBasis,
  type SkuChargeRow,
} from '@/lib/extraSkus'
import { monthStart } from '@/lib/skuUsage'

export type Interval = 'month' | 'year'
export const isInterval = (v: unknown): v is Interval => v === 'month' || v === 'year'

export type PlanPrice = { interval: Interval; amountCents: number; currency: string; stripePriceId: string | null }

export type Plan = {
  id: string
  name: string
  isCustom: boolean
  /** Retired custom plans are listed only so an account on one sees its name. */
  active: boolean
  selfServe: boolean
  includedSkus: number | null
  extraPer1000Cents: number | null
  feedLimit: number | null
  shopLimit: number | null
  userLimit: number | null
  syncsPerDay: number | null
  prices: PlanPrice[]
}

export type Subscription = {
  id: string
  planId: string
  interval: Interval
  status: string
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  /** When the subscription ends, if a cancellation is scheduled. */
  cancelAt: string | null
}

export type AccountBilling = {
  account: { id: string; name: string; type: 'mcc' | 'user'; billingExempt: boolean }
  subscription: Subscription | null
  /** The most recent plan that has ended or gone unpaid, when there's no live one. */
  previous: Subscription | null
  /** True when the account may use the app without paying (exempt or subscribed). */
  inGoodStanding: boolean
}

// Stripe statuses that keep an account in good standing. past_due keeps
// access while Stripe retries (grace period, brief E6).
const LIVE_STATUSES = ['active', 'trialing', 'past_due']

type PlanRow = {
  id: string
  name: string
  is_custom: boolean
  active: boolean
  self_serve: boolean
  included_skus: number | null
  extra_per_1000_cents: number | null
  feed_limit: number | null
  shop_limit: number | null
  user_limit: number | null
  syncs_per_day: number | null
  plan_prices: { interval: Interval; livemode: boolean; amount_cents: number; currency: string; stripe_price_id: string | null }[]
}

const PLAN_SELECT =
  'id, name, is_custom, active, self_serve, included_skus, extra_per_1000_cents, feed_limit, shop_limit, user_limit, syncs_per_day, plan_prices(interval, livemode, amount_cents, currency, stripe_price_id)'

function toPlan(r: PlanRow, livemode: boolean): Plan {
  return {
    id: r.id,
    name: r.name,
    isCustom: r.is_custom,
    active: r.active,
    selfServe: r.self_serve,
    includedSkus: r.included_skus,
    extraPer1000Cents: r.extra_per_1000_cents,
    feedLimit: r.feed_limit,
    shopLimit: r.shop_limit,
    userLimit: r.user_limit,
    syncsPerDay: r.syncs_per_day,
    prices: (r.plan_prices ?? [])
      .filter((p) => p.livemode === livemode)
      .map((p) => ({ interval: p.interval, amountCents: p.amount_cents, currency: p.currency, stripePriceId: p.stripe_price_id }))
      .sort((a, b) => (a.interval === b.interval ? 0 : a.interval === 'month' ? -1 : 1)),
  }
}

// The plans an account can see: active public plans, plus the custom plans
// made for this account (retired ones too, flagged, so a subscription on one
// still shows its name; they can't be bought).
export async function listPlansForAccount(db: SupabaseClient, accountId: string): Promise<Plan[]> {
  const { data, error } = await db
    .from('plans')
    .select(PLAN_SELECT)
    .or(`and(is_custom.eq.false,active.eq.true),account_id.eq.${accountId}`)
    .order('sort_order', { ascending: true })
  if (error) dbError('listPlansForAccount', error)
  const livemode = stripeLivemode()
  return ((data ?? []) as PlanRow[]).map((r) => toPlan(r, livemode))
}

export async function getAccountBilling(db: SupabaseClient, accountId: string): Promise<AccountBilling> {
  const livemode = stripeLivemode()
  const [{ data: acc, error: aErr }, { data: subs, error: sErr }] = await Promise.all([
    db.from('accounts').select('id, name, type, billing_exempt').eq('id', accountId).maybeSingle(),
    db
      .from('subscriptions')
      .select('id, plan_id, interval, status, current_period_end, cancel_at_period_end, cancel_at, updated_at')
      .eq('account_id', accountId)
      .eq('kind', 'plan')
      .eq('livemode', livemode)
      .order('updated_at', { ascending: false }),
  ])
  if (aErr) dbError('getAccountBilling account', aErr)
  if (sErr) dbError('getAccountBilling subscriptions', sErr)
  if (!acc) throw new AppError('The account does not exist', 404)
  const a = acc as { id: string; name: string; type: 'mcc' | 'user'; billing_exempt: boolean }

  type SubRow = {
    id: string
    plan_id: string
    interval: Interval
    status: string
    current_period_end: string | null
    cancel_at_period_end: boolean
    cancel_at: string | null
  }
  const rows = (subs ?? []) as SubRow[]
  const toSub = (s: SubRow): Subscription => ({
    id: s.id,
    planId: s.plan_id,
    interval: s.interval,
    status: s.status,
    currentPeriodEnd: s.current_period_end,
    cancelAtPeriodEnd: s.cancel_at_period_end,
    cancelAt: s.cancel_at ?? (s.cancel_at_period_end ? s.current_period_end : null),
  })
  const live = rows.find((s) => LIVE_STATUSES.includes(s.status)) ?? null
  const subscription = live ? toSub(live) : null
  // Rows are newest first; incomplete checkouts that never started don't count.
  const ended = !live ? rows.find((s) => s.status !== 'incomplete' && s.status !== 'incomplete_expired') : undefined

  return {
    account: { id: a.id, name: a.name, type: a.type, billingExempt: a.billing_exempt },
    subscription,
    previous: ended ? toSub(ended) : null,
    inGoodStanding: a.billing_exempt || subscription !== null,
  }
}

export async function canManageBilling(db: SupabaseClient, userId: string, accountId: string): Promise<boolean> {
  const role = await getAccountRole(db, userId, accountId)
  return role === 'owner' || role === 'admin'
}

async function requireBillingManager(db: SupabaseClient, userId: string, accountId: string): Promise<void> {
  const role = await getAccountRole(db, userId, accountId)
  if (!role) throw new AppError('The account does not exist', 404)
  if (role !== 'owner' && role !== 'admin') throw new AppError('Only owners and admins can manage billing', 403)
}

// The account's Stripe customer for the current mode, created on first use.
async function getOrCreateCustomer(
  db: SupabaseClient,
  account: { id: string; name: string },
  email: string | undefined
): Promise<string> {
  const livemode = stripeLivemode()
  const { data, error } = await db
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('account_id', account.id)
    .eq('livemode', livemode)
    .maybeSingle<{ stripe_customer_id: string }>()
  if (error) dbError('getOrCreateCustomer read', error)
  if (data) return data.stripe_customer_id

  const customer = await stripe().customers.create(
    { name: account.name, email, metadata: { account_id: account.id } },
    // Two clicks at once must not make two customers.
    { idempotencyKey: `customer-${account.id}-${livemode ? 'live' : 'test'}` }
  )
  const { error: insErr } = await db
    .from('stripe_customers')
    .insert({ account_id: account.id, livemode, stripe_customer_id: customer.id })
  if (insErr && insErr.code !== '23505') dbError('getOrCreateCustomer insert', insErr)
  if (insErr) {
    // Lost a race: use the row the other request wrote.
    const { data: again } = await db
      .from('stripe_customers')
      .select('stripe_customer_id')
      .eq('account_id', account.id)
      .eq('livemode', livemode)
      .single<{ stripe_customer_id: string }>()
    if (again) return again.stripe_customer_id
  }
  return customer.id
}

// Starts Stripe Checkout for a plan. Returns the URL to send the browser to.
export async function createCheckout(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
  accountId: string,
  planId: unknown,
  interval: unknown,
  origin: string
): Promise<string> {
  await requireBillingManager(db, user.id, accountId)
  if (typeof planId !== 'string' || !isInterval(interval)) throw new AppError('Choose a plan')

  const billing = await getAccountBilling(db, accountId)
  if (billing.account.billingExempt) throw new AppError('This account is free and needs no plan')
  if (billing.subscription) throw new AppError('The account already has a plan. Change it under Manage billing.')

  const plan = (await listPlansForAccount(db, accountId)).find((p) => p.id === planId)
  if (!plan || !plan.selfServe || !plan.active) throw new AppError('That plan is not available')
  const price = plan.prices.find((p) => p.interval === interval)
  if (!price?.stripePriceId) throw new AppError('That plan is not available yet. Try again later.', 503)

  const customer = await getOrCreateCustomer(db, billing.account, user.email ?? undefined)
  const meta = { account_id: accountId, plan_id: plan.id }
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: accountId,
    line_items: [{ price: price.stripePriceId, quantity: 1 }],
    metadata: meta,
    subscription_data: { metadata: meta },
    // VAT: Stripe Tax with the customer's VAT number (reverse charge in the EU).
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'required',
    customer_update: { address: 'auto', name: 'auto' },
    success_url: `${origin}/billing?account=${accountId}&checkout={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/billing?account=${accountId}`,
  })
  if (!session.url) throw new AppError('Checkout could not be started. Try again.')
  return session.url
}

// Moves a paying account onto its custom plan (lib/customPlans.ts). Checkout
// can't (one plan subscription per account) and the Stripe portal only offers
// the public plans, so the app swaps the price on the existing subscription.
// Stripe prorates: a dearer plan is invoiced at once (a declined card changes
// nothing), a cheaper one credited on the next invoice. Add-on items stay; changing the interval is only
// possible without them, since every item on a subscription shares it.
export async function switchToCustomPlan(
  db: SupabaseClient,
  user: { id: string },
  accountId: string,
  planId: unknown,
  interval: unknown
): Promise<void> {
  await requireBillingManager(db, user.id, accountId)
  if (typeof planId !== 'string' || !isInterval(interval)) throw new AppError('Choose a plan')

  const billing = await getAccountBilling(db, accountId)
  const current = billing.subscription
  if (!current) throw new AppError('The account has no plan to switch from. Choose the plan below instead.')
  if (current.planId === planId && current.interval === interval) throw new AppError('The account is already on that plan')
  if (current.status === 'past_due') throw new AppError('The last payment failed. Update your card under Manage billing first.')
  if (current.cancelAt) throw new AppError('Your plan is set to end. Renew it under Manage billing first, then switch.')

  const plan = (await listPlansForAccount(db, accountId)).find((p) => p.id === planId)
  if (!plan?.isCustom || !plan.active) throw new AppError('That plan is not available')
  const price = plan.prices.find((p) => p.interval === interval)
  if (!price?.stripePriceId) throw new AppError('That plan is not available yet. Try again later.', 503)

  const { data: row, error } = await db
    .from('subscriptions')
    .select('stripe_subscription_id')
    .eq('id', current.id)
    .single<{ stripe_subscription_id: string }>()
  if (error) dbError('switchToCustomPlan', error)
  const sub = await stripe().subscriptions.retrieve(row.stripe_subscription_id)
  const byPrice = await plansByPrice(db, sub.items.data.map((i) => i.price.id))
  const item = sub.items.data.find((i) => byPrice.has(i.price.id))
  if (!item) throw new AppError('The plan could not be found on your subscription. Contact us.')
  if (interval !== current.interval && sub.items.data.length > 1) {
    throw new AppError(
      `Add-ons are billed ${current.interval === 'year' ? 'yearly' : 'monthly'} with your plan, so switch to the ${
        current.interval === 'year' ? 'yearly' : 'monthly'
      } price, or contact us to change both.`
    )
  }

  // A switch that costs more is charged now. One that costs less is credited
  // on the next invoice instead: a credit invoice of its own would not reduce
  // the agency's kickback (lib/commissions.ts only counts paid invoices).
  const preview = await stripe().invoices.createPreview({
    subscription: sub.id,
    subscription_details: { items: [{ id: item.id, price: price.stripePriceId }], proration_behavior: 'always_invoice' },
  })
  const prorationBehavior = preview.total < 0 ? 'create_prorations' : 'always_invoice'

  let updated: Stripe.Subscription
  try {
    updated = await stripe().subscriptions.update(sub.id, {
      items: [{ id: item.id, price: price.stripePriceId }],
      proration_behavior: prorationBehavior,
      // Declined card: Stripe rejects the change instead of leaving it unpaid.
      payment_behavior: 'error_if_incomplete',
      metadata: { ...sub.metadata, account_id: accountId, plan_id: plan.id },
    })
  } catch (err) {
    if ((err as { type?: string }).type === 'StripeCardError') {
      throw new AppError('Your card was declined, so the plan was not changed. Update it under Manage billing and try again.', 402)
    }
    throw err
  }
  // Show the new plan at once; the webhook writes the same thing again.
  await syncSubscription(db, updated)
}

// Stripe's hosted portal: change card, switch plan, cancel, download invoices.
export async function createPortal(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
  accountId: string,
  origin: string
): Promise<string> {
  await requireBillingManager(db, user.id, accountId)
  const { data, error } = await db
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('account_id', accountId)
    .eq('livemode', stripeLivemode())
    .maybeSingle<{ stripe_customer_id: string }>()
  if (error) dbError('createPortal', error)
  if (!data) throw new AppError('The account has no billing details yet. Choose a plan first.')
  const session = await stripe().billingPortal.sessions.create({
    customer: data.stripe_customer_id,
    return_url: `${origin}/billing?account=${accountId}`,
  })
  return session.url
}

// ── Keeping subscriptions in step with Stripe ─────────────────────────────

async function accountForCustomer(db: SupabaseClient, customerId: string): Promise<string | null> {
  const { data, error } = await db
    .from('stripe_customers')
    .select('account_id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle<{ account_id: string }>()
  if (error) dbError('accountForCustomer', error)
  return data?.account_id ?? null
}

// Which of a subscription's prices are plan prices. The rest are add-ons
// (lib/addons.ts), which ride on the same subscription.
async function plansByPrice(db: SupabaseClient, priceIds: string[]): Promise<Map<string, string>> {
  if (!priceIds.length) return new Map()
  const { data, error } = await db
    .from('plan_prices')
    .select('plan_id, stripe_price_id')
    .in('stripe_price_id', priceIds)
  if (error) dbError('plansByPrice', error)
  return new Map(
    ((data ?? []) as { plan_id: string; stripe_price_id: string | null }[])
      .filter((r) => r.stripe_price_id)
      .map((r) => [r.stripe_price_id as string, r.plan_id])
  )
}

// Writes Stripe's view of a subscription into `subscriptions`. Safe to call
// any number of times with the same subscription (webhook replays, the
// checkout return page).
export async function syncSubscription(db: SupabaseClient, sub: Stripe.Subscription): Promise<void> {
  if (sub.livemode !== stripeLivemode()) return

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const accountId = sub.metadata?.account_id || (await accountForCustomer(db, customerId))
  if (!accountId) {
    console.error('[billing] subscription without a known account:', sub.id)
    return
  }

  // The plan's own item, not an add-on's (a subscription carries both).
  const byPrice = await plansByPrice(db, sub.items.data.map((i) => i.price.id))
  const item = sub.items.data.find((i) => byPrice.has(i.price.id)) ?? sub.items.data[0]
  if (!item) return
  // A plan switched in the portal changes the price; the price says which plan.
  const planId = byPrice.get(item.price.id) ?? sub.metadata?.plan_id
  if (!planId) {
    console.error('[billing] subscription with an unknown price:', sub.id, item.price.id)
    return
  }
  const interval = item.price.recurring?.interval === 'year' ? 'year' : 'month'

  const { error } = await db.from('subscriptions').upsert(
    {
      account_id: accountId,
      plan_id: planId,
      kind: 'plan',
      interval,
      status: sub.status,
      stripe_subscription_id: sub.id,
      // Since Stripe API 2025-03, the period lives on the subscription item.
      current_period_end: item.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
      // Stripe schedules a cancellation either with the flag or (the portal,
      // current API) with a cancel_at date. Either means "ending".
      cancel_at_period_end: sub.cancel_at_period_end || sub.cancel_at !== null,
      cancel_at:
        sub.cancel_at !== null
          ? new Date(sub.cancel_at * 1000).toISOString()
          : sub.cancel_at_period_end && item.current_period_end
            ? new Date(item.current_period_end * 1000).toISOString()
            : null,
      livemode: sub.livemode,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'stripe_subscription_id,kind' }
  )
  if (error) dbError('syncSubscription', error)

  // What Stripe bills is what the account has: add-on items on this
  // subscription are written through, and ones taken off in the portal closed.
  await reconcileAddonItems(db, accountId, sub)

  // Reactivated with a new subscription: cancel the account's old unpaid ones,
  // so Stripe can't charge for both.
  if (sub.status === 'active' || sub.status === 'trialing') {
    const { data: stale, error: sErr } = await db
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('account_id', accountId)
      .eq('kind', 'plan')
      .eq('livemode', sub.livemode)
      .neq('stripe_subscription_id', sub.id)
      .in('status', ['past_due', 'unpaid'])
    if (sErr) dbError('syncSubscription stale', sErr)
    for (const s of (stale ?? []) as { stripe_subscription_id: string }[]) {
      try {
        await stripe().subscriptions.cancel(s.stripe_subscription_id)
      } catch (err) {
        console.error('[billing] could not cancel old subscription', s.stripe_subscription_id, err)
      }
    }
  }
}

// The checkout return page calls this so the plan shows at once, even when
// the webhook hasn't arrived yet. Only for the account the session was for.
export async function syncCheckoutSession(db: SupabaseClient, accountId: string, sessionId: string): Promise<void> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return
  const session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ['subscription'] })
  if (session.client_reference_id !== accountId) return
  if (session.subscription && typeof session.subscription !== 'string') {
    await syncSubscription(db, session.subscription)
  }
}

// Handles one verified webhook event. An event already recorded in
// stripe_events is skipped; the handlers are idempotent anyway, so an event
// that fails half-way is safe for Stripe to resend.
export async function handleStripeEvent(db: SupabaseClient, event: Stripe.Event): Promise<'handled' | 'skipped'> {
  if (event.livemode !== stripeLivemode()) return 'skipped'

  const { data: seen, error: seenErr } = await db.from('stripe_events').select('id').eq('id', event.id).maybeSingle()
  if (seenErr) dbError('handleStripeEvent seen', seenErr)
  if (seen) return 'skipped'

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object
      if (session.mode === 'subscription' && session.subscription) {
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id
        await syncSubscription(db, await stripe().subscriptions.retrieve(subId))
      }
      break
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // Re-read it: events can arrive out of order, Stripe's current state can't.
      const sub = await stripe().subscriptions.retrieve(event.data.object.id)
      await syncSubscription(db, sub)
      // Ended: agency kickback parts not due yet are dropped (decision 26).
      if (sub.status === 'canceled') {
        const { data: row } = await db
          .from('subscriptions')
          .select('id')
          .eq('stripe_subscription_id', sub.id)
          .eq('kind', 'plan')
          .maybeSingle<{ id: string }>()
        if (row) await dropFutureParts(db, { subscriptionId: row.id })
      }
      break
    }
    case 'invoice.paid': {
      // Starts a referral on the first payment and writes the agency's kickback.
      // A new subscription's first invoice.paid can arrive before the events
      // that record the subscription, so record it from Stripe first.
      const invoice = event.data.object
      const ref = invoice.parent?.subscription_details?.subscription
      const subId = typeof ref === 'string' ? ref : ref?.id
      if (subId) await syncSubscription(db, await stripe().subscriptions.retrieve(subId))
      await recordPaidInvoice(db, invoice)
      break
    }
    case 'credit_note.created': {
      // A refund: scales the agency's kickback on that invoice down.
      const note = event.data.object
      const invoiceId = typeof note.invoice === 'string' ? note.invoice : note.invoice?.id
      if (invoiceId) {
        const invoice = await stripe().invoices.retrieve(invoiceId)
        await recordCreditNote(db, note, invoice.total)
      }
      break
    }
    default:
      break
  }

  const { error } = await db
    .from('stripe_events')
    .insert({ id: event.id, type: event.type, livemode: event.livemode })
  if (error && error.code !== '23505') dbError('handleStripeEvent record', error)
  return 'handled'
}

// ── Usage and add-ons for the Billing page ────────────────────────────────

export type PlanSuggestion = {
  planId: string
  name: string
  /** What that plan would cost at this month's peak, in the same interval. */
  wouldCostCents: number
  /** What the current plan costs at the same peak, base plus extra SKUs. */
  nowCostCents: number
  currency: string
}

export type BillingUsage = {
  month: string
  /** What the month's extras come to so far; null without a live plan. */
  basis: ExtraSkuBasis | null
  /** Earlier months, newest first. */
  charges: SkuChargeRow[]
  /** A cheaper plan at this month's peak, when extras have grown past one. */
  cheaper: PlanSuggestion | null
}

export type BillingDetail = {
  usage: BillingUsage
  /** What the account has now. */
  addons: AccountAddon[]
  /** What it could add (active, self-serve, priced for its interval). */
  catalogue: Addon[]
}

// Everything the Billing page shows besides the plan itself: this month's SKU
// usage, what earlier months cost, the add-ons on the account and the ones it
// can buy. One call, so the page makes a single round of queries.
export async function getBillingDetail(db: SupabaseClient, accountId: string): Promise<BillingDetail> {
  const month = monthStart(new Date())
  const [basis, charges, addons, catalogue, plans] = await Promise.all([
    extraSkuBasis(db, accountId, month),
    recentSkuCharges(db, accountId),
    accountAddons(db, accountId),
    listAddons(db, true),
    listPlansForAccount(db, accountId),
  ])

  return {
    usage: { month, basis, charges, cheaper: cheaperPlan(basis, plans, addons) },
    addons,
    catalogue: catalogue.filter((a) => a.selfServe),
  }
}

// With no ceiling on extra SKUs (decision 28), a shop can grow past the point
// where the next plan is cheaper. This finds that plan so the page can say so;
// nothing changes on its own.
function cheaperPlan(basis: ExtraSkuBasis | null, plans: Plan[], addons: AccountAddon[]): PlanSuggestion | null {
  if (!basis || basis.includedSkus === null || basis.ratePer1000Cents === null) return null
  const skuDelta = addons.reduce((n, a) => n + a.skuDelta * a.quantity, 0)
  const costOf = (plan: Plan): { cents: number; currency: string } | null => {
    const price = plan.prices.find((p) => p.interval === basis.interval)
    if (!price?.stripePriceId || plan.includedSkus === null || plan.extraPer1000Cents === null) return null
    const included = plan.includedSkus + skuDelta
    const rate = ratePer1000({ extraPer1000Cents: plan.extraPer1000Cents }, basis.interval) ?? 0
    return {
      cents: price.amountCents + Math.round(extraThousands(basis.peakSkus, included) * rate),
      currency: price.currency,
    }
  }

  const now = costOf(plans.find((p) => p.id === basis.planId) ?? ({} as Plan))
  if (!now) return null
  let best: PlanSuggestion | null = null
  for (const plan of plans) {
    if (plan.id === basis.planId || !plan.active || !plan.selfServe) continue
    const cost = costOf(plan)
    if (!cost || cost.cents >= now.cents) continue
    if (!best || cost.cents < best.wouldCostCents) {
      best = { planId: plan.id, name: plan.name, wouldCostCents: cost.cents, nowCostCents: now.cents, currency: cost.currency }
    }
  }
  return best
}
