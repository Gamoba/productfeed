// Add-ons (migration 066, decision 29): extras a customer can put on its plan
// — a managed service, coaching, a pack of extra feeds.
//
//   - The catalogue is made by platform admins (Admin › Add-ons): name,
//     description, monthly and/or yearly price, an optional quantity, and the
//     limits one unit raises (feeds, shops, users, included SKUs). Nothing is
//     hard-coded, so a price change needs no release.
//   - The app creates the Stripe product and prices, as for custom plans.
//   - An add-on rides on the account's plan subscription, at the same interval,
//     so the customer gets one invoice. Stripe prorates the rest of the period:
//     on a monthly plan on the next invoice, on a yearly one invoiced at once.
//     Taking one off credits the unused part on the next invoice.
//   - An owner or admin of the account buys and removes add-ons on Billing
//     (self-serve). A platform admin can also put one on an account, billed or
//     free (decision 30). A free grant has no Stripe item: it raises the
//     limits and costs nothing.
//   - Stripe is the truth for what is billed: every subscription event
//     reconciles the account's add-on rows (lib/billing.ts).
//
// Takes the service-role client; callers check the session user first.

import { randomBytes } from 'crypto'
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { requirePlatformAdmin } from '@/lib/platformAdmin'
import { stripe, stripeLivemode } from '@/lib/stripe'

// SaaS, business use — as scripts/stripe-setup.ts and lib/customPlans.ts.
const TAX_CODE = 'txcd_10103001'

export type Interval = 'month' | 'year'

export type AddonPrice = { interval: Interval; amountCents: number; currency: string; stripePriceId: string | null }

export type Addon = {
  id: string
  name: string
  description: string | null
  active: boolean
  selfServe: boolean
  quantityEnabled: boolean
  maxQuantity: number | null
  feedDelta: number
  shopDelta: number
  userDelta: number
  skuDelta: number
  prices: AddonPrice[]
}

export type AccountAddon = {
  id: string
  addonId: string
  name: string
  description: string | null
  quantity: number
  interval: Interval | null
  free: boolean
  note: string | null
  /** What it costs per interval, per unit; null for a free grant. */
  unitAmountCents: number | null
  currency: string
  feedDelta: number
  shopDelta: number
  userDelta: number
  skuDelta: number
}

export type AddonLimits = { feedDelta: number; shopDelta: number; userDelta: number; skuDelta: number }

const NO_LIMITS: AddonLimits = { feedDelta: 0, shopDelta: 0, userDelta: 0, skuDelta: 0 }

const ADDON_SELECT =
  'id, name, description, active, self_serve, quantity_enabled, max_quantity, feed_delta, shop_delta, user_delta, sku_delta, sort_order, addon_prices(interval, livemode, amount_cents, currency, stripe_price_id)'

type AddonRow = {
  id: string
  name: string
  description: string | null
  active: boolean
  self_serve: boolean
  quantity_enabled: boolean
  max_quantity: number | null
  feed_delta: number
  shop_delta: number
  user_delta: number
  sku_delta: number
  sort_order: number
  addon_prices: { interval: Interval; livemode: boolean; amount_cents: number; currency: string; stripe_price_id: string | null }[]
}

function toAddon(r: AddonRow, livemode: boolean): Addon {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    active: r.active,
    selfServe: r.self_serve,
    quantityEnabled: r.quantity_enabled,
    maxQuantity: r.max_quantity,
    feedDelta: r.feed_delta,
    shopDelta: r.shop_delta,
    userDelta: r.user_delta,
    skuDelta: r.sku_delta,
    prices: (r.addon_prices ?? [])
      .filter((p) => p.livemode === livemode)
      .map((p) => ({ interval: p.interval, amountCents: p.amount_cents, currency: p.currency, stripePriceId: p.stripe_price_id }))
      .sort((a, b) => (a.interval === b.interval ? 0 : a.interval === 'month' ? -1 : 1)),
  }
}

/** The catalogue. `onlyActive` for the Billing page; admins see retired ones too. */
export async function listAddons(db: SupabaseClient, onlyActive = false): Promise<Addon[]> {
  let q = db.from('addons').select(ADDON_SELECT).order('sort_order', { ascending: true }).order('name')
  if (onlyActive) q = q.eq('active', true)
  const { data, error } = await q
  if (error) {
    // Before migration 066 the tables don't exist: no add-ons, not an error.
    if (error.code === '42P01' || error.code === 'PGRST205') return []
    dbError('listAddons', error)
  }
  const livemode = stripeLivemode()
  return ((data ?? []) as unknown as AddonRow[]).map((r) => toAddon(r, livemode))
}

type AccountAddonRow = {
  id: string
  addon_id: string
  quantity: number
  interval: Interval | null
  free: boolean
  note: string | null
  addons: AddonRow | null
}

const ACCOUNT_ADDON_SELECT = `id, addon_id, quantity, interval, free, note, addons(${ADDON_SELECT})`

/** What an account has now (active rows only). */
export async function accountAddons(db: SupabaseClient, accountId: string): Promise<AccountAddon[]> {
  const { data, error } = await db
    .from('account_addons')
    .select(ACCOUNT_ADDON_SELECT)
    .eq('account_id', accountId)
    .eq('livemode', stripeLivemode())
    .eq('status', 'active')
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return []
    dbError('accountAddons', error)
  }
  const livemode = stripeLivemode()
  return ((data ?? []) as unknown as AccountAddonRow[])
    .filter((r) => r.addons)
    .map((r) => {
      const a = toAddon(r.addons!, livemode)
      const price = r.interval ? a.prices.find((p) => p.interval === r.interval) : undefined
      return {
        id: r.id,
        addonId: r.addon_id,
        name: a.name,
        description: a.description,
        quantity: r.quantity,
        interval: r.interval,
        free: r.free,
        note: r.note,
        unitAmountCents: r.free ? null : (price?.amountCents ?? null),
        currency: price?.currency ?? 'eur',
        feedDelta: a.feedDelta,
        shopDelta: a.shopDelta,
        userDelta: a.userDelta,
        skuDelta: a.skuDelta,
      }
    })
    .sort((x, y) => x.name.localeCompare(y.name))
}

/** What the account's add-ons add to its plan limits, for several accounts at once. */
export async function addonLimitsForMany(db: SupabaseClient, accountIds: string[]): Promise<Map<string, AddonLimits>> {
  const out = new Map<string, AddonLimits>()
  const ids = [...new Set(accountIds)]
  if (!ids.length) return out
  const { data, error } = await db
    .from('account_addons')
    .select('account_id, quantity, addons(feed_delta, shop_delta, user_delta, sku_delta)')
    .in('account_id', ids)
    .eq('livemode', stripeLivemode())
    .eq('status', 'active')
  if (error) {
    // Before migration 066: no add-ons anywhere.
    if (error.code === '42P01' || error.code === 'PGRST205') return out
    dbError('addonLimitsForMany', error)
  }
  for (const r of (data ?? []) as unknown as {
    account_id: string
    quantity: number
    addons: { feed_delta: number; shop_delta: number; user_delta: number; sku_delta: number } | null
  }[]) {
    if (!r.addons) continue
    const cur = out.get(r.account_id) ?? { ...NO_LIMITS }
    cur.feedDelta += r.addons.feed_delta * r.quantity
    cur.shopDelta += r.addons.shop_delta * r.quantity
    cur.userDelta += r.addons.user_delta * r.quantity
    cur.skuDelta += r.addons.sku_delta * r.quantity
    out.set(r.account_id, cur)
  }
  return out
}

export async function addonLimitsFor(db: SupabaseClient, accountId: string): Promise<AddonLimits> {
  return (await addonLimitsForMany(db, [accountId])).get(accountId) ?? { ...NO_LIMITS }
}

// ── The catalogue (platform admins) ───────────────────────────────────────

export type AddonInput = {
  name: unknown
  description?: unknown
  monthlyEuros?: unknown
  yearlyEuros?: unknown
  quantityEnabled?: unknown
  maxQuantity?: unknown
  feedDelta?: unknown
  shopDelta?: unknown
  userDelta?: unknown
  skuDelta?: unknown
  selfServe?: unknown
}

function whole(v: unknown, label: string, min = 0): number | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
  if (s === '') return null
  const n = Number(s)
  if (!Number.isInteger(n) || n < min) throw new AppError(`${label} must be a whole number of at least ${min}, or empty`)
  return n
}

function cents(v: unknown, label: string): number | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().replace(',', '.') : ''
  if (s === '') return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) throw new AppError(`${label} must be a price above 0, or empty`)
  return Math.round(n * 100)
}

export async function createAddon(db: SupabaseClient, adminId: string, input: AddonInput): Promise<string> {
  await requirePlatformAdmin(db, adminId)
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : ''
  if (!name) throw new AppError('Give the add-on a name, e.g. "5 extra feeds"')
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 500) || null : null
  const monthly = cents(input.monthlyEuros, 'The monthly price')
  const yearly = cents(input.yearlyEuros, 'The yearly price')
  if (monthly === null && yearly === null) throw new AppError('Set a monthly price, a yearly price, or both')

  const deltas = {
    feed_delta: whole(input.feedDelta, 'Extra feeds') ?? 0,
    shop_delta: whole(input.shopDelta, 'Extra shops') ?? 0,
    user_delta: whole(input.userDelta, 'Extra users') ?? 0,
    sku_delta: whole(input.skuDelta, 'Extra included SKUs') ?? 0,
  }
  const quantityEnabled = input.quantityEnabled === true || input.quantityEnabled === 'on' || input.quantityEnabled === 'true'
  const maxQuantity = whole(input.maxQuantity, 'The highest quantity', 1)
  const selfServe = !(input.selfServe === false || input.selfServe === 'false')

  const id = `addon-${randomBytes(5).toString('hex')}`
  const { error } = await db.from('addons').insert({
    id,
    name,
    description,
    active: true,
    self_serve: selfServe,
    quantity_enabled: quantityEnabled,
    max_quantity: quantityEnabled ? maxQuantity : null,
    ...deltas,
    created_by: adminId,
  })
  if (error) dbError('createAddon', error)

  try {
    await createStripePrices(db, id, name, description, { month: monthly, year: yearly })
  } catch (err) {
    // No half-made add-ons: without a price it can't be sold.
    await db.from('addons').delete().eq('id', id)
    throw err
  }
  return id
}

async function createStripePrices(
  db: SupabaseClient,
  addonId: string,
  name: string,
  description: string | null,
  amounts: { month: number | null; year: number | null }
): Promise<void> {
  const livemode = stripeLivemode()
  const product = await stripe().products.create({
    name: `Kompara ${name}`,
    ...(description ? { description } : {}),
    metadata: { addon_id: addonId },
    tax_code: TAX_CODE,
  })
  for (const interval of ['month', 'year'] as const) {
    const amount = amounts[interval]
    if (amount === null) continue
    const price = await stripe().prices.create({
      product: product.id,
      unit_amount: amount,
      currency: 'eur',
      recurring: { interval },
      tax_behavior: 'exclusive',
      metadata: { addon_id: addonId },
    })
    const { error } = await db.from('addon_prices').insert({
      addon_id: addonId,
      interval,
      livemode,
      amount_cents: amount,
      currency: 'eur',
      stripe_price_id: price.id,
    })
    if (error) dbError('createAddon prices', error)
  }
}

export async function setAddonActive(db: SupabaseClient, adminId: string, addonId: string, active: boolean): Promise<void> {
  await requirePlatformAdmin(db, adminId)
  const { error } = await db.from('addons').update({ active }).eq('id', addonId)
  if (error) dbError('setAddonActive', error)
}

// ── Buying, removing, granting ────────────────────────────────────────────

type LiveSub = { id: string; interval: Interval; stripe_subscription_id: string }

const LIVE = ['active', 'trialing', 'past_due']

async function livePlanSubscription(db: SupabaseClient, accountId: string): Promise<LiveSub | null> {
  const { data, error } = await db
    .from('subscriptions')
    .select('id, interval, status, stripe_subscription_id')
    .eq('account_id', accountId)
    .eq('kind', 'plan')
    .eq('livemode', stripeLivemode())
    .order('updated_at', { ascending: false })
  if (error) dbError('livePlanSubscription', error)
  const row = ((data ?? []) as (LiveSub & { status: string })[]).find((s) => LIVE.includes(s.status))
  return row ? { id: row.id, interval: row.interval, stripe_subscription_id: row.stripe_subscription_id } : null
}

// The member's role, read here rather than through lib/accounts.ts: that
// module reads entitlements, which read this one, and a cycle between them is
// easy to break by accident.
async function requireBillingManager(db: SupabaseClient, userId: string, accountId: string): Promise<void> {
  const { data, error } = await db
    .from('account_members')
    .select('role')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .maybeSingle<{ role: string }>()
  if (error) dbError('requireBillingManager', error)
  if (!data) throw new AppError('The account does not exist', 404)
  if (data.role !== 'owner' && data.role !== 'admin') {
    throw new AppError('Only owners and admins can manage billing', 403)
  }
}

async function getAddon(db: SupabaseClient, addonId: string): Promise<Addon> {
  const { data, error } = await db.from('addons').select(ADDON_SELECT).eq('id', addonId).maybeSingle()
  if (error) dbError('getAddon', error)
  if (!data) throw new AppError('That add-on does not exist', 404)
  return toAddon(data as unknown as AddonRow, stripeLivemode())
}

function wantedQuantity(addon: Addon, quantity: unknown): number {
  if (!addon.quantityEnabled) return 1
  const n = Number(typeof quantity === 'string' ? quantity.trim() : quantity)
  if (!Number.isInteger(n) || n < 1) throw new AppError('Choose how many you want (1 or more)')
  if (addon.maxQuantity !== null && n > addon.maxQuantity) {
    throw new AppError(`At most ${addon.maxQuantity} of this add-on. Contact us for more.`)
  }
  return n
}

// How Stripe settles an add-on change mid-period. Monthly: on the next
// invoice, at most a month away. Yearly: invoiced at once, or the customer
// would get the extra limits now and pay for them up to a year later. A
// declined card then rejects the change instead of leaving it unpaid.
// Taking one off always credits on the next invoice: a credit invoice of its
// own (negative total) would not reduce the agency's kickback
// (lib/commissions.ts only counts paid invoices), a credit line does.
function settle(interval: Interval) {
  return interval === 'year'
    ? ({ proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' } as const)
    : ({ proration_behavior: 'create_prorations' } as const)
}
async function declinedAsAppError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if ((err as { type?: string }).type === 'StripeCardError') {
      throw new AppError('The card was declined, so the add-on was not changed. Update it under Manage billing and try again.', 402)
    }
    throw err
  }
}

type ActiveRow = {
  id: string
  quantity: number
  interval: Interval | null
  free: boolean
  stripe_subscription_item_id: string | null
}

async function activeRow(db: SupabaseClient, accountId: string, addonId: string): Promise<ActiveRow | null> {
  const { data, error } = await db
    .from('account_addons')
    .select('id, quantity, interval, free, stripe_subscription_item_id')
    .eq('account_id', accountId)
    .eq('addon_id', addonId)
    .eq('livemode', stripeLivemode())
    .eq('status', 'active')
    .maybeSingle<ActiveRow>()
  if (error) dbError('activeRow', error)
  return data
}

// Puts an add-on on the account's plan subscription and records it. Stripe
// prorates the rest of the period.
async function attach(
  db: SupabaseClient,
  accountId: string,
  addon: Addon,
  quantity: number,
  by: { adminId?: string } = {}
): Promise<void> {
  const sub = await livePlanSubscription(db, accountId)
  if (!sub) throw new AppError('The account needs a plan before it can have add-ons')
  const price = addon.prices.find((p) => p.interval === sub.interval)
  if (!price?.stripePriceId) {
    throw new AppError(
      `“${addon.name}” isn’t available ${sub.interval === 'year' ? 'yearly' : 'monthly'}. Ask us to set up that price.`,
      503
    )
  }

  const existing = await activeRow(db, accountId, addon.id)
  if (existing) {
    if (!addon.quantityEnabled) throw new AppError(`The account already has “${addon.name}”`)
    if (existing.free || !existing.stripe_subscription_item_id) {
      throw new AppError(`“${addon.name}” was given to this account by us. Ask us to change it.`)
    }
    await declinedAsAppError(() =>
      stripe().subscriptionItems.update(existing.stripe_subscription_item_id!, {
        quantity: existing.quantity + quantity,
        ...settle(sub.interval),
      })
    )
    const { error } = await db
      .from('account_addons')
      .update({ quantity: existing.quantity + quantity, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) dbError('attach addon update', error)
    return
  }

  const item = await declinedAsAppError(() =>
    stripe().subscriptionItems.create({
      subscription: sub.stripe_subscription_id,
      price: price.stripePriceId!,
      quantity,
      ...settle(sub.interval),
      metadata: { addon_id: addon.id, account_id: accountId },
    })
  )
  const { error } = await db.from('account_addons').insert({
    account_id: accountId,
    addon_id: addon.id,
    quantity,
    interval: sub.interval,
    status: 'active',
    free: false,
    granted_by: by.adminId ?? null,
    stripe_subscription_id: sub.stripe_subscription_id,
    stripe_subscription_item_id: item.id,
    livemode: stripeLivemode(),
  })
  if (error) {
    // Couldn't record it: take it off Stripe again rather than bill silently.
    try {
      await stripe().subscriptionItems.del(item.id, { proration_behavior: 'create_prorations' })
    } catch (err) {
      console.error('[addons] could not undo subscription item', item.id, err)
    }
    dbError('attach addon insert', error)
  }
}

/** Self-serve: an owner or admin of the account buys an add-on. */
export async function buyAddon(
  db: SupabaseClient,
  userId: string,
  accountId: string,
  addonId: unknown,
  quantity: unknown
): Promise<void> {
  await requireBillingManager(db, userId, accountId)
  if (typeof addonId !== 'string' || !addonId) throw new AppError('Choose an add-on')
  const addon = await getAddon(db, addonId)
  if (!addon.active || !addon.selfServe) throw new AppError('That add-on isn’t available. Contact us about it.')
  await attach(db, accountId, addon, wantedQuantity(addon, quantity))
}

/** Self-serve: taking an add-on off. Stripe credits the unused part. */
export async function removeAddon(db: SupabaseClient, userId: string, accountId: string, addonId: unknown): Promise<void> {
  await requireBillingManager(db, userId, accountId)
  if (typeof addonId !== 'string' || !addonId) throw new AppError('Choose an add-on')
  const row = await activeRow(db, accountId, addonId)
  if (!row) throw new AppError('The account doesn’t have that add-on')
  if (row.free || !row.stripe_subscription_item_id) {
    throw new AppError('We put this add-on on the account, so only we can take it off. Get in touch and we’ll do it.')
  }
  await stripe().subscriptionItems.del(row.stripe_subscription_item_id, { proration_behavior: 'create_prorations' })
  const { error } = await db
    .from('account_addons')
    .update({ status: 'removed', removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', row.id)
  if (error) dbError('removeAddon', error)
}

/**
 * A platform admin puts an add-on on an account: billed like a self-serve one,
 * or free (no Stripe item, limits only — for an add-on thrown in on a deal).
 */
export async function grantAddon(
  db: SupabaseClient,
  adminId: string,
  accountId: unknown,
  addonId: unknown,
  opts: { quantity?: unknown; free?: unknown; note?: unknown } = {}
): Promise<void> {
  await requirePlatformAdmin(db, adminId)
  if (typeof accountId !== 'string' || !accountId) throw new AppError('Choose an account')
  if (typeof addonId !== 'string' || !addonId) throw new AppError('Choose an add-on')
  const addon = await getAddon(db, addonId)
  const quantity = wantedQuantity(addon, opts.quantity ?? 1)
  const note = typeof opts.note === 'string' ? opts.note.trim().slice(0, 500) || null : null
  const free = opts.free === true || opts.free === 'on' || opts.free === 'true'

  const { data: acc, error: aErr } = await db.from('accounts').select('id').eq('id', accountId).maybeSingle()
  if (aErr) dbError('grantAddon account', aErr)
  if (!acc) throw new AppError('That account does not exist', 404)

  if (!free) {
    await attach(db, accountId, addon, quantity, { adminId })
    if (note) {
      const row = await activeRow(db, accountId, addon.id)
      if (row) await db.from('account_addons').update({ note }).eq('id', row.id)
    }
    return
  }

  const existing = await activeRow(db, accountId, addon.id)
  if (existing) {
    if (existing.stripe_subscription_item_id) {
      throw new AppError('The account pays for that add-on already. Take it off on its Billing page first.')
    }
    const { error } = await db
      .from('account_addons')
      .update({ quantity, free: true, note, granted_by: adminId, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
    if (error) dbError('grantAddon update', error)
    return
  }
  const { error } = await db.from('account_addons').insert({
    account_id: accountId,
    addon_id: addon.id,
    quantity,
    interval: null,
    status: 'active',
    free: true,
    granted_by: adminId,
    note,
    livemode: stripeLivemode(),
  })
  if (error) dbError('grantAddon insert', error)
}

/** A platform admin takes a free grant off again. */
export async function revokeFreeAddon(db: SupabaseClient, adminId: string, accountAddonId: unknown): Promise<void> {
  await requirePlatformAdmin(db, adminId)
  if (typeof accountAddonId !== 'string' || !accountAddonId) throw new AppError('Choose the add-on to take off')
  const { data, error } = await db
    .from('account_addons')
    .select('id, free, stripe_subscription_item_id')
    .eq('id', accountAddonId)
    .maybeSingle<{ id: string; free: boolean; stripe_subscription_item_id: string | null }>()
  if (error) dbError('revokeFreeAddon read', error)
  if (!data) throw new AppError('That add-on is not on the account', 404)
  if (!data.free || data.stripe_subscription_item_id) {
    throw new AppError('That one is billed through Stripe. Remove it from the account’s Billing page.')
  }
  const { error: uErr } = await db
    .from('account_addons')
    .update({ status: 'removed', removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', data.id)
  if (uErr) dbError('revokeFreeAddon', uErr)
}

// ── Keeping the rows in step with Stripe ──────────────────────────────────

/**
 * Reconciles an account's billed add-ons against a Stripe subscription: what
 * Stripe bills is what the account has. Items whose price isn't an add-on (the
 * plan itself) are ignored, and free grants are left alone.
 */
export async function reconcileAddonItems(db: SupabaseClient, accountId: string, sub: Stripe.Subscription): Promise<void> {
  const livemode = stripeLivemode()
  if (sub.livemode !== livemode) return

  const priceIds = sub.items.data.map((i) => i.price.id)
  const { data: prices, error } = await db
    .from('addon_prices')
    .select('addon_id, interval, stripe_price_id')
    .eq('livemode', livemode)
    .in('stripe_price_id', priceIds.length ? priceIds : ['none'])
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return
    dbError('reconcileAddonItems prices', error)
  }
  const byPrice = new Map(
    ((prices ?? []) as { addon_id: string; interval: Interval; stripe_price_id: string }[]).map((p) => [p.stripe_price_id, p])
  )

  const seen: string[] = []
  for (const item of sub.items.data) {
    const price = byPrice.get(item.price.id)
    if (!price) continue
    seen.push(item.id)
    const row = {
      account_id: accountId,
      addon_id: price.addon_id,
      quantity: item.quantity ?? 1,
      interval: price.interval,
      status: 'active',
      free: false,
      stripe_subscription_id: sub.id,
      stripe_subscription_item_id: item.id,
      livemode,
      updated_at: new Date().toISOString(),
    }
    const { error: uErr } = await db.from('account_addons').upsert(row, { onConflict: 'stripe_subscription_item_id' })
    if (uErr) {
      // A row for the same add-on from an earlier item: close it and try again.
      if (uErr.code === '23505') {
        await db
          .from('account_addons')
          .update({ status: 'removed', removed_at: new Date().toISOString() })
          .eq('account_id', accountId)
          .eq('addon_id', price.addon_id)
          .eq('livemode', livemode)
          .eq('status', 'active')
          .neq('stripe_subscription_item_id', item.id)
        const { error: again } = await db.from('account_addons').upsert(row, { onConflict: 'stripe_subscription_item_id' })
        if (again) dbError('reconcileAddonItems upsert', again)
      } else dbError('reconcileAddonItems upsert', uErr)
    }
  }

  // Billed add-on rows Stripe no longer has: removed in the portal, or the
  // plan was switched. Free grants (no item) are untouched.
  let gone = db
    .from('account_addons')
    .update({ status: 'removed', removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('livemode', livemode)
    .eq('status', 'active')
    .eq('free', false)
    .not('stripe_subscription_item_id', 'is', null)
  if (seen.length) gone = gone.not('stripe_subscription_item_id', 'in', `(${seen.join(',')})`)
  const { error: gErr } = await gone
  if (gErr && gErr.code !== '42P01' && gErr.code !== 'PGRST205') dbError('reconcileAddonItems removed', gErr)
}

// ── Admin listing ─────────────────────────────────────────────────────────

export type AddonGrant = {
  id: string
  accountId: string
  accountName: string
  addonId: string
  addonName: string
  quantity: number
  interval: Interval | null
  free: boolean
  note: string | null
}

export type AdminAddons = {
  addons: Addon[]
  /** Accounts an add-on can be put on. */
  accounts: { id: string; name: string }[]
  /** Who has what, free grants included. */
  grants: AddonGrant[]
}

export async function listAddonsForAdmin(db: SupabaseClient, adminId: string): Promise<AdminAddons> {
  await requirePlatformAdmin(db, adminId)
  const livemode = stripeLivemode()
  const [addons, { data: accounts, error: aErr }, { data: rows, error: gErr }] = await Promise.all([
    listAddons(db),
    db.from('accounts').select('id, name').order('name'),
    db
      .from('account_addons')
      .select('id, account_id, addon_id, quantity, interval, free, note, addons(name), accounts(name)')
      .eq('status', 'active')
      .eq('livemode', livemode),
  ])
  if (aErr) dbError('listAddonsForAdmin accounts', aErr)
  if (gErr && gErr.code !== '42P01' && gErr.code !== 'PGRST205') dbError('listAddonsForAdmin grants', gErr)

  const grants = ((rows ?? []) as unknown as {
    id: string
    account_id: string
    addon_id: string
    quantity: number
    interval: Interval | null
    free: boolean
    note: string | null
    addons: { name: string } | null
    accounts: { name: string } | null
  }[]).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.accounts?.name ?? '—',
    addonId: r.addon_id,
    addonName: r.addons?.name ?? r.addon_id,
    quantity: r.quantity,
    interval: r.interval,
    free: r.free,
    note: r.note,
  }))

  return {
    addons,
    accounts: ((accounts ?? []) as { id: string; name: string }[]),
    grants: grants.sort((x, y) => x.accountName.localeCompare(y.accountName) || x.addonName.localeCompare(y.addonName)),
  }
}
