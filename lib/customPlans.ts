// Custom plans (decision 24): a plan made by a platform admin for one company
// Gamoba has an agreement with. The "contact us" Enterprise route ends here.
//
//   - Prices (monthly and/or yearly) and limits are set by the admin. The app
//     creates the Stripe product and prices, so the customer pays through
//     Checkout and manages it in the portal like any other plan.
//   - For an existing customer account: the plan is theirs at once.
//   - For a new company: a one-time signup link (/signup?plan=<token>, 30
//     days, optionally locked to one email). Signing up through it gives the
//     new account the plan (lib/signup.ts). Only the token's hash is stored.
//   - The account sees its custom plan first on Billing, the public plans below.
//
// Takes the service-role client; every write checks for a platform admin.

import { createHash, randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { requirePlatformAdmin } from '@/lib/platformAdmin'
import { stripe, stripeLivemode } from '@/lib/stripe'
import { sendEmail } from '@/lib/email'

const LINK_DAYS = 30
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const hash = (t: string) => createHash('sha256').update(t).digest('hex')

export type CustomPlanInput = {
  name: unknown
  note?: unknown
  monthlyEuros?: unknown
  yearlyEuros?: unknown
  includedSkus?: unknown
  feedLimit?: unknown
  shopLimit?: unknown
  userLimit?: unknown
  syncsPerDay?: unknown
  /** An existing customer account, or null for a new company (signup link). */
  accountId?: unknown
  /** New company: lock the link to this email, and send it there. */
  email?: unknown
}

// '' → null (unlimited / not offered); otherwise a whole number ≥ min.
function limit(v: unknown, label: string, min = 0): number | null {
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

export type CreatedCustomPlan = { planId: string; link: string | null; emailed: boolean }

export async function createCustomPlan(
  db: SupabaseClient,
  adminId: string,
  input: CustomPlanInput,
  origin: string
): Promise<CreatedCustomPlan> {
  await requirePlatformAdmin(db, adminId)
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : ''
  if (!name) throw new AppError('Give the plan a name, e.g. "Enterprise – Company X"')
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) || null : null
  const monthly = cents(input.monthlyEuros, 'The monthly price')
  const yearly = cents(input.yearlyEuros, 'The yearly price')
  if (monthly === null && yearly === null) throw new AppError('Set a monthly price, a yearly price, or both')
  const limits = {
    included_skus: limit(input.includedSkus, 'Included SKUs'),
    feed_limit: limit(input.feedLimit, 'Feeds'),
    shop_limit: limit(input.shopLimit, 'Shops'),
    user_limit: limit(input.userLimit, 'Users', 1),
    syncs_per_day: limit(input.syncsPerDay, 'Syncs per day', 1),
  }

  let accountId: string | null = null
  if (typeof input.accountId === 'string' && input.accountId) {
    const { data: acc, error } = await db.from('accounts').select('id, type').eq('id', input.accountId).maybeSingle<{ id: string; type: string }>()
    if (error) dbError('createCustomPlan account', error)
    if (!acc) throw new AppError('That account does not exist')
    accountId = acc.id
  }
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (email && !EMAIL_RE.test(email)) throw new AppError('Enter a valid email address, or leave it empty')

  const planId = `custom-${randomBytes(5).toString('hex')}`
  const { error: pErr } = await db.from('plans').insert({
    id: planId,
    name,
    note,
    is_custom: true,
    account_id: accountId,
    self_serve: true,
    sort_order: 0,
    created_by: adminId,
    ...limits,
  })
  if (pErr) dbError('createCustomPlan plan', pErr)

  try {
    await createStripePrices(db, planId, name, { month: monthly, year: yearly })
  } catch (err) {
    // No half-made plans: without prices it can't be bought.
    await db.from('plans').delete().eq('id', planId)
    throw err
  }

  if (accountId) return { planId, link: null, emailed: false }
  return { planId, ...(await createLink(db, adminId, planId, name, email || null, origin)) }
}

async function createStripePrices(
  db: SupabaseClient,
  planId: string,
  name: string,
  amounts: { month: number | null; year: number | null }
): Promise<void> {
  const livemode = stripeLivemode()
  const product = await stripe().products.create({
    name: `Kompara ${name}`,
    metadata: { plan_id: planId },
    tax_code: 'txcd_10103001', // SaaS, business use (as scripts/stripe-setup.ts)
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
      metadata: { plan_id: planId },
    })
    const { error } = await db.from('plan_prices').insert({
      plan_id: planId,
      interval,
      livemode,
      amount_cents: amount,
      currency: 'eur',
      stripe_price_id: price.id,
    })
    if (error) dbError('createStripePrices', error)
  }
}

async function createLink(
  db: SupabaseClient,
  adminId: string,
  planId: string,
  planName: string,
  email: string | null,
  origin: string
): Promise<{ link: string; emailed: boolean }> {
  const token = randomBytes(24).toString('base64url')
  const { error } = await db.from('plan_signup_links').insert({
    plan_id: planId,
    token_hash: hash(token),
    email,
    created_by: adminId,
    expires_at: new Date(Date.now() + LINK_DAYS * 86400_000).toISOString(),
  })
  if (error) dbError('createLink', error)
  const link = `${origin}/signup?plan=${token}`
  const emailed = email
    ? await sendEmail({
        to: [email],
        subject: `Your Kompara plan: ${planName}`,
        paragraphs: [
          `As agreed, we've set up ${planName} for you on Kompara.`,
          `Create your account through the link below; the plan is waiting on the Billing page. The link works once and for ${LINK_DAYS} days.`,
        ],
        button: { label: 'Create your account', url: link },
      })
    : false
  return { link, emailed }
}

// A new link for a custom plan nobody has signed up to yet (the old one
// expired, or went to the wrong person). Older unused links stop working.
export async function newPlanLink(
  db: SupabaseClient,
  adminId: string,
  planId: string,
  email: unknown,
  origin: string
): Promise<{ link: string; emailed: boolean }> {
  await requirePlatformAdmin(db, adminId)
  const { data: plan, error } = await db.from('plans').select('name, is_custom, account_id').eq('id', planId).maybeSingle<{ name: string; is_custom: boolean; account_id: string | null }>()
  if (error) dbError('newPlanLink plan', error)
  if (!plan?.is_custom) throw new AppError('That custom plan does not exist', 404)
  if (plan.account_id) throw new AppError('The plan already belongs to an account')
  const mail = typeof email === 'string' ? email.trim().toLowerCase() : ''
  if (mail && !EMAIL_RE.test(mail)) throw new AppError('Enter a valid email address, or leave it empty')
  await db.from('plan_signup_links').update({ expires_at: new Date().toISOString() }).eq('plan_id', planId).is('used_at', null)
  return createLink(db, adminId, planId, plan.name, mail || null, origin)
}

export async function setCustomPlanActive(db: SupabaseClient, adminId: string, planId: string, active: boolean): Promise<void> {
  await requirePlatformAdmin(db, adminId)
  const { error } = await db.from('plans').update({ active }).eq('id', planId).eq('is_custom', true)
  if (error) dbError('setCustomPlanActive', error)
}

// ── Signup through a link ──────────────────────────────────────────────────

type LinkRow = { id: string; plan_id: string; email: string | null; expires_at: string; used_at: string | null }

async function findLink(db: SupabaseClient, token: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null
  const { data, error } = await db
    .from('plan_signup_links')
    .select('id, plan_id, email, expires_at, used_at')
    .eq('token_hash', hash(token))
    .maybeSingle<LinkRow>()
  if (error) dbError('findLink', error)
  return data
}

// What the signup page shows for ?plan=<token>; null when the link can't be used.
export async function planLinkInfo(db: SupabaseClient, token: string): Promise<{ planName: string; email: string | null } | null> {
  const link = await findLink(db, token)
  if (!link || link.used_at || new Date(link.expires_at) < new Date()) return null
  const { data: plan } = await db.from('plans').select('name, account_id, active').eq('id', link.plan_id).maybeSingle<{ name: string; account_id: string | null; active: boolean }>()
  if (!plan || plan.account_id || !plan.active) return null
  return { planName: plan.name, email: link.email }
}

// Gives a newly created account the link's plan (once). Returns false when the
// link can't be used (expired, used, another email): the account then simply
// sees the public plans.
export async function claimPlanLink(db: SupabaseClient, token: string, accountId: string, email: string): Promise<boolean> {
  const link = await findLink(db, token)
  if (!link || link.used_at || new Date(link.expires_at) < new Date()) return false
  if (link.email && link.email !== email.toLowerCase()) return false
  const { data: claimed, error } = await db
    .from('plan_signup_links')
    .update({ used_at: new Date().toISOString(), account_id: accountId })
    .eq('id', link.id)
    .is('used_at', null)
    .select('id')
  if (error) dbError('claimPlanLink link', error)
  if (!claimed?.length) return false
  const { data: plan, error: pErr } = await db
    .from('plans')
    .update({ account_id: accountId })
    .eq('id', link.plan_id)
    .is('account_id', null)
    .select('id')
  if (pErr) dbError('claimPlanLink plan', pErr)
  return !!plan?.length
}

// ── Admin list ─────────────────────────────────────────────────────────────

export type CustomPlanRow = {
  id: string
  name: string
  note: string | null
  active: boolean
  account: { id: string; name: string } | null
  prices: { interval: 'month' | 'year'; amountCents: number }[]
  limits: { includedSkus: number | null; feeds: number | null; shops: number | null; users: number | null; syncsPerDay: number | null }
  link: { email: string | null; expiresAt: string; expired: boolean } | null
  subscribed: boolean
}

export async function listCustomPlans(db: SupabaseClient, adminId: string): Promise<{ plans: CustomPlanRow[]; accounts: { id: string; name: string }[] }> {
  await requirePlatformAdmin(db, adminId)
  const livemode = stripeLivemode()
  const [{ data: plans, error }, { data: links }, { data: accounts }, { data: subs }] = await Promise.all([
    db
      .from('plans')
      .select('id, name, note, active, account_id, included_skus, feed_limit, shop_limit, user_limit, syncs_per_day, created_at, plan_prices(interval, livemode, amount_cents)')
      .eq('is_custom', true)
      .order('created_at', { ascending: false }),
    db.from('plan_signup_links').select('plan_id, email, expires_at, used_at').is('used_at', null).order('created_at', { ascending: false }),
    db.from('accounts').select('id, name').eq('type', 'user').order('name'),
    db.from('subscriptions').select('plan_id').in('status', ['active', 'trialing', 'past_due']).eq('livemode', livemode),
  ])
  if (error) dbError('listCustomPlans', error)
  const accName = new Map(((accounts ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]))
  const openLink = new Map<string, { email: string | null; expires_at: string }>()
  for (const l of (links ?? []) as { plan_id: string; email: string | null; expires_at: string }[]) {
    if (!openLink.has(l.plan_id)) openLink.set(l.plan_id, l)
  }
  const subscribed = new Set(((subs ?? []) as { plan_id: string }[]).map((s) => s.plan_id))
  type P = {
    id: string; name: string; note: string | null; active: boolean; account_id: string | null
    included_skus: number | null; feed_limit: number | null; shop_limit: number | null; user_limit: number | null; syncs_per_day: number | null
    plan_prices: { interval: 'month' | 'year'; livemode: boolean; amount_cents: number }[]
  }
  return {
    accounts: ((accounts ?? []) as { id: string; name: string }[]),
    plans: ((plans ?? []) as P[]).map((p) => {
      const l = openLink.get(p.id)
      return {
        id: p.id,
        name: p.name,
        note: p.note,
        active: p.active,
        account: p.account_id ? { id: p.account_id, name: accName.get(p.account_id) ?? '—' } : null,
        prices: (p.plan_prices ?? [])
          .filter((x) => x.livemode === livemode)
          .map((x) => ({ interval: x.interval, amountCents: x.amount_cents }))
          .sort((a, b) => (a.interval === b.interval ? 0 : a.interval === 'month' ? -1 : 1)),
        limits: { includedSkus: p.included_skus, feeds: p.feed_limit, shops: p.shop_limit, users: p.user_limit, syncsPerDay: p.syncs_per_day },
        link: !p.account_id && l ? { email: l.email, expiresAt: l.expires_at, expired: new Date(l.expires_at) < new Date() } : null,
        subscribed: subscribed.has(p.id),
      }
    }),
  }
}
