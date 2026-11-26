// Plan limits, checked before an action. Shared by the UI's routes and actions
// and by the MCP tools (Claude), so a limit that blocks something in the app
// blocks it through Claude too.
//
// A refused action throws LimitError: an AppError whose message the user
// sees, plus where to upgrade. errorResponse() passes `upgrade` through.

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { frequencyAllowed, getEntitlements, shopsLocked, type Entitlements } from '@/lib/entitlements'
import { AUTO_SYNC_LABELS, type AutoSyncFrequency } from '@/lib/syncSchedule'

export class LimitError extends AppError {
  upgrade: string
  constructor(message: string, accountId: string) {
    super(message, 403)
    this.name = 'LimitError'
    this.upgrade = `/billing?account=${accountId}`
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

async function load(db: SupabaseClient, accountId: string): Promise<Entitlements> {
  const e = await getEntitlements(db, accountId)
  if (!e) throw new AppError('The account does not exist', 404)
  return e
}

function assertUsable(e: Entitlements): void {
  if (e.type === 'mcc' && e.standing !== 'exempt' && !e.plan) {
    throw new LimitError('An agency account needs a plan to have shops of its own.', e.accountId)
  }
  if (e.locked) {
    throw new LimitError(
      e.standing === 'lapsed' ? 'The account’s plan has ended. Reactivate it to continue.' : 'Choose a plan to get started.',
      e.accountId
    )
  }
}

export async function assertCanCreateShop(db: SupabaseClient, accountId: string): Promise<void> {
  const e = await load(db, accountId)
  assertUsable(e)
  const limit = e.plan?.shopLimit
  if (limit === null || limit === undefined) return
  const { count, error } = await db.from('projects').select('id', { count: 'exact', head: true }).eq('account_id', accountId)
  if (error) dbError('assertCanCreateShop', error)
  if ((count ?? 0) >= limit) {
    throw new LimitError(`Your ${e.plan!.name} plan includes ${plural(limit, 'shop', 'shops')}. Upgrade to add more.`, accountId)
  }
}

export async function assertCanCreateFeed(db: SupabaseClient, accountId: string): Promise<void> {
  const e = await load(db, accountId)
  assertUsable(e)
  const limit = e.plan?.feedLimit
  if (limit === null || limit === undefined) return
  const { count, error } = await db
    .from('feeds')
    .select('id, projects!inner(account_id)', { count: 'exact', head: true })
    .eq('projects.account_id', accountId)
  if (error) dbError('assertCanCreateFeed', error)
  if ((count ?? 0) >= limit) {
    throw new LimitError(`Your ${e.plan!.name} plan includes ${plural(limit, 'feed', 'feeds')}. Upgrade to add more.`, accountId)
  }
}

// `current` = members today, invited ones included.
export async function assertCanAddMember(db: SupabaseClient, accountId: string, current: number): Promise<void> {
  const e = await load(db, accountId)
  if (e.type === 'mcc') return // MCC seats are unlimited
  assertUsable(e)
  const limit = e.plan?.userLimit
  if (limit === null || limit === undefined) return
  if (current >= limit) {
    throw new LimitError(`Your ${e.plan!.name} plan includes ${plural(limit, 'user', 'users')}. Upgrade to add more.`, accountId)
  }
}

export async function assertFrequencyAllowed(db: SupabaseClient, accountId: string, frequency: string): Promise<void> {
  const e = await load(db, accountId)
  assertUsable(e)
  if (!frequencyAllowed(e, frequency)) {
    const label = AUTO_SYNC_LABELS[frequency as AutoSyncFrequency] ?? frequency
    const plan = e.plan ? `${e.plan.name} plan` : 'plan'
    throw new LimitError(`“${label}” isn’t included in your ${plan}. Upgrade for more frequent syncs.`, accountId)
  }
}

export { shopsLocked }
