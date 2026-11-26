// Open signup for User accounts (docs/billing-data-model.md).
//
// Supabase's own signup stays switched OFF in the dashboard, so the public
// anon key can't create logins. Signup goes through startSignup(), on the
// server, which:
//   1. creates the login with the admin API and emails an invite (Supabase
//      sends it through the project's custom SMTP),
//   2. stores the company name and referral code in app_metadata, which the
//      user can't edit (user_metadata they can).
// The email link lands on /auth/invite, where they choose a password; then
// completeSignup() creates the User account, and the referral if any.
//
// An email that already has a login gets the same "check your email" answer
// and no email, so the form can't be used to find out who has an account.

import { randomBytes } from 'crypto'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REF_RE = /^[A-Za-z0-9_-]{3,64}$/

export type PendingSignup = { company: string; ref: string | null }

export async function startSignup(
  db: SupabaseClient,
  input: { name: unknown; company: unknown; email: unknown; ref: unknown },
  redirectTo: string
): Promise<void> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : ''
  const company = typeof input.company === 'string' ? input.company.trim().slice(0, 120) : ''
  if (!name) throw new AppError('Enter your name.')
  if (!company) throw new AppError('Enter your company name.')
  if (!EMAIL_RE.test(email)) throw new AppError('Enter a valid email address.')
  const ref = typeof input.ref === 'string' && REF_RE.test(input.ref) ? input.ref : null

  const { data: existingId, error: lookupErr } = await db.rpc('auth_user_id_by_email', { p_email: email })
  if (lookupErr) dbError('startSignup lookup', lookupErr)
  if (existingId) {
    // A signup that was never finished (link expired, or opened but no
    // password chosen): start it over. Only a login that still waits on this
    // signup and belongs to no account is replaced; it owns nothing yet.
    // Every other existing login is left alone.
    const { data: ex } = await db.auth.admin.getUserById(existingId as string)
    const u = ex?.user
    if (!u || !readPending(u)) return
    const { data: memberships } = await db.from('account_members').select('account_id').eq('user_id', u.id).limit(1)
    if ((memberships ?? []).length > 0) return
    const { error: delErr } = await db.auth.admin.deleteUser(u.id)
    if (delErr) {
      console.error('[startSignup] replace stale signup:', delErr)
      return
    }
  }

  const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { full_name: name },
  })
  if (error || !data?.user) {
    console.error('[startSignup] inviteUserByEmail:', error)
    throw new AppError('We could not send the email. Try again in a moment.')
  }

  const pending: PendingSignup = { company, ref }
  const { error: metaErr } = await db.auth.admin.updateUserById(data.user.id, {
    app_metadata: { ...(data.user.app_metadata ?? {}), pending_signup: pending },
  })
  if (metaErr) {
    console.error('[startSignup] updateUserById:', metaErr)
    throw new AppError('We could not finish the signup. Try again in a moment.')
  }
}

// 10 characters from an alphabet without look-alikes (no 0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export function newAccessCode(): string {
  const bytes = randomBytes(10)
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

function readPending(user: Pick<User, 'app_metadata'>): PendingSignup | null {
  const p = (user.app_metadata as Record<string, unknown> | undefined)?.pending_signup as PendingSignup | undefined
  return p && typeof p.company === 'string' ? p : null
}

// True when the session's token says a signup is still waiting to be
// finished. Cheap (no network); completeSignup() re-checks against Supabase.
export function hasPendingSignup(user: Pick<User, 'app_metadata'>): boolean {
  return readPending(user) !== null
}

async function defaultCommissionRate(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'default_commission_rate')
    .maybeSingle<{ value: unknown }>()
  if (error) dbError('defaultCommissionRate', error)
  const v = Number(data?.value)
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    console.error('[signup] platform_settings.default_commission_rate is not set; using 0')
    return 0
  }
  return v
}

// Turns a pending signup into a User account with the person as owner, and
// records the referral when they came through an MCC's link. Idempotent: a
// second call (a refresh, a retry) finds nothing pending and does nothing.
// Returns where to go next, or null when there was nothing to finish.
export async function completeSignup(db: SupabaseClient, userId: string): Promise<string | null> {
  // Read fresh: the session token may still show a signup that's done.
  const { data: fresh, error: userErr } = await db.auth.admin.getUserById(userId)
  if (userErr || !fresh?.user) {
    console.error('[completeSignup] getUserById:', userErr)
    return null
  }
  const user = fresh.user
  const pending = readPending(user)
  if (!pending) return null

  // Already has an account (e.g. the earlier attempt failed after creating
  // it): reuse it rather than make a second one.
  const { data: owned, error: ownedErr } = await db
    .from('accounts')
    .select('id')
    .eq('created_by', userId)
    .eq('type', 'user')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (ownedErr) dbError('completeSignup owned', ownedErr)

  let accountId = owned?.id ?? null
  if (!accountId) {
    let created: { id: string } | null = null
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const { data, error } = await db
        .from('accounts')
        .insert({ name: pending.company, type: 'user', created_by: userId, access_code: newAccessCode() })
        .select('id')
        .single<{ id: string }>()
      if (error?.code === '23505') continue // access code collision: draw again
      if (error) dbError('completeSignup account', error)
      created = data
    }
    if (!created) throw new AppError('The account could not be created. Try again.')
    accountId = created.id
  }

  const { error: memberErr } = await db
    .from('account_members')
    .upsert({ account_id: accountId, user_id: userId, role: 'owner' }, { onConflict: 'account_id,user_id', ignoreDuplicates: true })
  if (memberErr) dbError('completeSignup member', memberErr)

  if (pending.ref) await recordReferral(db, accountId, userId, pending.ref)

  const { error: clearErr } = await db.auth.admin.updateUserById(userId, {
    app_metadata: { ...(user.app_metadata ?? {}), pending_signup: null },
  })
  if (clearErr) console.error('[completeSignup] clear pending:', clearErr)

  return `/billing?account=${accountId}`
}

// Referral link → the MCC gets account access at once, and the referral is
// pending until the first paid invoice. Unknown or retired codes are ignored:
// the signup still goes through, just without a referrer.
async function recordReferral(db: SupabaseClient, userAccountId: string, userId: string, code: string): Promise<void> {
  const { data: link, error } = await db
    .from('referral_links')
    .select('id, mcc_account_id, accounts!referral_links_mcc_account_id_fkey(type, commission_rate)')
    .eq('code', code)
    .eq('active', true)
    .maybeSingle()
  if (error) dbError('recordReferral link', error)
  if (!link) return
  const l = link as unknown as {
    id: string
    mcc_account_id: string
    accounts: { type: string; commission_rate: number | string | null } | null
  }
  if (l.accounts?.type !== 'mcc') return

  const { data: existing, error: exErr } = await db
    .from('referrals')
    .select('id')
    .eq('user_account_id', userAccountId)
    .maybeSingle()
  if (exErr) dbError('recordReferral existing', exErr)
  if (existing) return

  const { data: grant, error: gErr } = await db
    .from('access_grants')
    .insert({
      user_account_id: userAccountId,
      mcc_account_id: l.mcc_account_id,
      scope: 'account',
      source: 'referral',
      status: 'active',
      requested_by: userId,
      decided_by: userId,
      accepted_at: new Date().toISOString(),
    })
    .select('id')
    .single<{ id: string }>()
  if (gErr) dbError('recordReferral grant', gErr)

  const rate = l.accounts.commission_rate !== null ? Number(l.accounts.commission_rate) : await defaultCommissionRate(db)
  const { error: rErr } = await db.from('referrals').insert({
    mcc_account_id: l.mcc_account_id,
    user_account_id: userAccountId,
    referral_link_id: l.id,
    access_grant_id: grant?.id ?? null,
    commission_rate: rate,
  })
  if (rErr && rErr.code !== '23505') dbError('recordReferral referral', rErr)
}
