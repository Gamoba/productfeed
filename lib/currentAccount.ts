// The account a login is working in (decision 14). One login can belong to
// several accounts, agency (MCC) and customer (User) alike; the app shows one
// at a time, chosen with the switcher at the top of the sidebar.
//
//   - The choice is a cookie, and only a preference: every read checks it
//     against the user's real memberships and falls back to the oldest one.
//   - It decides what the app lists and which account a page acts on: the
//     dashboard, monitoring, the menu, Billing, Users and the agency pages.
//     For an agency that includes the clients it reaches (lib/mccAccess.ts).
//   - It doesn't decide access. Opening a shop or feed checks every account
//     the user belongs to, as before (lib/feeds.ts); the shell then switches
//     to the account that shop belongs to (app/api/shell).
//
// Takes the service-role client.

import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import type { AccountRole } from '@/lib/accounts'

export const CURRENT_ACCOUNT_COOKIE = 'kompara_account'
const ONE_YEAR = 365 * 86_400

export type OwnAccount = { id: string; name: string; type: 'mcc' | 'user'; role: AccountRole }

// Every account the user is a real member of, oldest membership first.
export async function listOwnAccounts(db: SupabaseClient, userId: string): Promise<OwnAccount[]> {
  const { data, error } = await db
    .from('account_members')
    .select('account_id, role, created_at, accounts!inner(name, type)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) dbError('listOwnAccounts', error)
  type Row = { account_id: string; role: AccountRole; accounts: { name: string; type: 'mcc' | 'user' } | { name: string; type: 'mcc' | 'user' }[] }
  return ((data ?? []) as Row[]).map((r) => {
    const a = Array.isArray(r.accounts) ? r.accounts[0] : r.accounts
    return { id: r.account_id, name: a?.name ?? 'Account', type: a?.type ?? 'user', role: r.role }
  })
}

export function pickCurrent(accounts: OwnAccount[], wanted: string | null | undefined): OwnAccount | null {
  return accounts.find((a) => a.id === wanted) ?? accounts[0] ?? null
}

/** The cookie's value, unchecked. Use getCurrentAccount for anything that matters. */
export async function currentAccountPreference(): Promise<string | null> {
  return (await cookies()).get(CURRENT_ACCOUNT_COOKIE)?.value ?? null
}

/** The account the user is working in, and every account they can switch to. */
export async function getCurrentAccount(
  db: SupabaseClient,
  userId: string
): Promise<{ current: OwnAccount | null; accounts: OwnAccount[] }> {
  const [accounts, wanted] = await Promise.all([listOwnAccounts(db, userId), currentAccountPreference()])
  return { current: pickCurrent(accounts, wanted), accounts }
}

/**
 * Stores the choice. Only from a Route Handler or Server Function (Next can't
 * set cookies while rendering), and only for an account the caller has
 * checked the user belongs to.
 */
export async function rememberCurrentAccount(accountId: string): Promise<void> {
  ;(await cookies()).set(CURRENT_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ONE_YEAR,
  })
}
