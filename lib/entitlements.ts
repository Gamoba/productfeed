// What an account may do, from its billing state (migrations 061–062).
//
// Standing:
//   exempt  free account (existing customers, Gamoba): no limits
//   active  live subscription: the plan's limits apply
//   grace   payment failed, Stripe still retrying (past_due): as active,
//           with a banner
//   new     User account that has never had a plan: only Billing
//   lapsed  had a plan that ended or went unpaid: only Billing (with the
//           previous plan and a reactivate button); its feeds stop serving
//
// MCC accounts are free and never locked as accounts. Shops they own need a
// live plan, like a User's.
//
// `locked` means the account's shops and feeds can't be used or served.
//
// Lookups by account id, batched; callers check membership themselves.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import { stripeLivemode } from '@/lib/stripe'

export type Standing = 'exempt' | 'active' | 'grace' | 'new' | 'lapsed'

export type PlanLimits = {
  id: string
  name: string
  feedLimit: number | null
  shopLimit: number | null
  userLimit: number | null
  syncsPerDay: number | null
}

export type Entitlements = {
  accountId: string
  type: 'mcc' | 'user'
  standing: Standing
  /** Shops and feeds can't be used or served. */
  locked: boolean
  /** The plan whose limits apply; null = no limits (exempt) or no plan. */
  plan: PlanLimits | null
}

// Statuses that keep access: past_due is the grace period while Stripe retries.
const LIVE = ['active', 'trialing', 'past_due']

type AccountRow = { id: string; type: 'mcc' | 'user'; billing_exempt: boolean }
type SubRow = {
  account_id: string
  status: string
  plans: { id: string; name: string; feed_limit: number | null; shop_limit: number | null; user_limit: number | null; syncs_per_day: number | null } | null
}

function derive(account: AccountRow, subs: SubRow[]): Entitlements {
  const base = { accountId: account.id, type: account.type }
  if (account.billing_exempt) return { ...base, standing: 'exempt', locked: false, plan: null }
  const live = subs.find((s) => LIVE.includes(s.status))
  if (live?.plans) {
    const p = live.plans
    return {
      ...base,
      standing: live.status === 'past_due' ? 'grace' : 'active',
      locked: false,
      plan: { id: p.id, name: p.name, feedLimit: p.feed_limit, shopLimit: p.shop_limit, userLimit: p.user_limit, syncsPerDay: p.syncs_per_day },
    }
  }
  // A checkout whose first payment never went through ('incomplete') isn't a
  // plan that ended: the account is still new.
  const hadPlan = subs.some((s) => s.status !== 'incomplete' && s.status !== 'incomplete_expired')
  const standing: Standing = hadPlan ? 'lapsed' : 'new'
  return { ...base, standing, locked: true, plan: null }
}

export async function getEntitlementsMany(db: SupabaseClient, accountIds: string[]): Promise<Map<string, Entitlements>> {
  const out = new Map<string, Entitlements>()
  const ids = [...new Set(accountIds)]
  if (ids.length === 0) return out

  const { data: accounts, error } = await db.from('accounts').select('id, type, billing_exempt').in('id', ids)
  if (error) dbError('getEntitlementsMany accounts', error)
  const rows = (accounts ?? []) as AccountRow[]

  // Free accounts need no second query (every existing customer today).
  const paying = rows.filter((a) => !a.billing_exempt).map((a) => a.id)
  let subs: SubRow[] = []
  if (paying.length) {
    const { data, error: sErr } = await db
      .from('subscriptions')
      .select('account_id, status, plans(id, name, feed_limit, shop_limit, user_limit, syncs_per_day)')
      .in('account_id', paying)
      .eq('kind', 'plan')
      .eq('livemode', stripeLivemode())
      .order('updated_at', { ascending: false })
    if (sErr) dbError('getEntitlementsMany subscriptions', sErr)
    subs = (data ?? []) as unknown as SubRow[]
  }
  for (const a of rows) out.set(a.id, derive(a, subs.filter((s) => s.account_id === a.id)))
  return out
}

export async function getEntitlements(db: SupabaseClient, accountId: string): Promise<Entitlements | null> {
  return (await getEntitlementsMany(db, [accountId])).get(accountId) ?? null
}

// Accounts whose shops and feeds are unusable. An MCC with no plan owns no
// shops, so it isn't "locked" as an account, but any shop it does own is.
export function shopsLocked(e: Entitlements): boolean {
  if (e.locked) return true
  return e.type === 'mcc' && e.standing !== 'exempt' && e.plan === null
}

export async function lockedAccountIds(db: SupabaseClient, accountIds: string[]): Promise<Set<string>> {
  const ents = await getEntitlementsMany(db, accountIds)
  return new Set([...ents.values()].filter(shopsLocked).map((e) => e.accountId))
}

// For the app shell: a User account that can't be used sends its members to
// Billing. MCC accounts never block the app.
export function blocksApp(e: Entitlements): boolean {
  return e.type === 'user' && e.locked
}

// ── Sync frequency ─────────────────────────────────────────────────────────

const RUNS_PER_DAY = { hourly: 24, '6h': 4, '12h': 2, daily: 1 } as const

// Whether a plan allows a schedule. Standard (1/day) → daily; Advanced
// (2/day) → also every 12 h; Pro and Enterprise (5/day) → also every 6 h.
// Hourly needs a free account or a custom plan with 24+ syncs a day.
export function frequencyAllowed(e: Entitlements, frequency: string): boolean {
  if (frequency === 'off') return true
  if (e.standing === 'exempt') return true
  const runs = RUNS_PER_DAY[frequency as keyof typeof RUNS_PER_DAY]
  if (runs === undefined) return false
  if (!e.plan) return false
  return e.plan.syncsPerDay === null || runs <= e.plan.syncsPerDay
}

// The most frequent schedule allowed, for the cron: a feed set to hourly on
// a plan that allows daily runs daily.
export function capFrequency(e: Entitlements, frequency: string): string {
  if (frequencyAllowed(e, frequency)) return frequency
  // Most frequent first: the first allowed one that isn't more frequent than asked.
  const asked = RUNS_PER_DAY[frequency as keyof typeof RUNS_PER_DAY] ?? 1
  const steps = ['hourly', '6h', '12h', 'daily'] as const
  return steps.find((f) => RUNS_PER_DAY[f] <= asked && frequencyAllowed(e, f)) ?? 'daily'
}

// ── Public feed URLs ───────────────────────────────────────────────────────

// True when a feed must not be served: its shop's account has no usable plan.
// Free accounts (every existing customer) answer from the one join, with no
// subscription lookup. A feed or shop that can't be found is not blocked here;
// the caller's own lookup decides that.
export async function feedServingBlocked(db: SupabaseClient, feedId: string): Promise<boolean> {
  const { data, error } = await db
    .from('feeds')
    .select('projects(account_id, accounts(billing_exempt))')
    .eq('id', feedId)
    .maybeSingle()
  if (error) {
    // Serving a paying customer's feed matters more than blocking a lapsed one
    // for a moment: on a lookup error, serve.
    console.error('[entitlements] feedServingBlocked:', error)
    return false
  }
  const p = (data as unknown as { projects: { account_id: string; accounts: { billing_exempt: boolean } | null } | null } | null)?.projects
  if (!p) return false
  if (p.accounts?.billing_exempt) return false
  return (await lockedAccountIds(db, [p.account_id])).has(p.account_id)
}
