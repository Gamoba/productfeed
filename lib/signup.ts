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
//
// A referral (?ref=) gives an agency access to the new account, so it is only
// recorded when the person agrees on the password page (refConsent): someone
// else could have typed their email on another agency's link. Submitting the
// form again for a signup that's still waiting re-sends the email but keeps
// the first submission's details.

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { newAccessCode } from '@/lib/accessCode'
import { getDefaultCommissionRate } from '@/lib/platformAdmin'
import { acceptMccInvite } from '@/lib/mcc'
import { claimPlanLink } from '@/lib/customPlans'

export { newAccessCode }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REF_RE = /^[A-Za-z0-9_-]{3,64}$/

/**
 * `plan`: a custom plan's signup link token (lib/customPlans.ts).
 * `refConsent`: the person's answer on the password page to the referring
 * agency getting access; the referral is recorded only when true.
 */
export type PendingSignup = { company: string; ref: string | null; plan?: string | null; refConsent?: boolean }

export async function startSignup(
  db: SupabaseClient,
  input: { name: unknown; company: unknown; email: unknown; ref: unknown; plan?: unknown },
  redirectTo: string
): Promise<void> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : ''
  const company = typeof input.company === 'string' ? input.company.trim().slice(0, 120) : ''
  if (!name) throw new AppError('Enter your name.')
  if (!company) throw new AppError('Enter your company name.')
  if (!EMAIL_RE.test(email)) throw new AppError('Enter a valid email address.')
  const ref = typeof input.ref === 'string' && REF_RE.test(input.ref) ? input.ref : null
  const plan = typeof input.plan === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(input.plan) ? input.plan : null

  let pending: PendingSignup = { company, ref, plan }
  let fullName = name
  const { data: existingId, error: lookupErr } = await db.rpc('auth_user_id_by_email', { p_email: email })
  if (lookupErr) dbError('startSignup lookup', lookupErr)
  if (existingId) {
    // A signup that was never finished (the link expired, or was never
    // opened): send the email again. Only a login that still waits on a
    // signup, has never signed in and belongs to no account is replaced; it
    // owns nothing yet. Every other existing login is left alone — one that
    // has signed in finishes its signup on its next visit (app/page.tsx).
    const { data: ex } = await db.auth.admin.getUserById(existingId as string)
    const u = ex?.user
    const first = u ? readPending(u) : null
    if (!u || !first || u.last_sign_in_at) return
    const { data: memberships } = await db.from('account_members').select('account_id').eq('user_id', u.id).limit(1)
    if ((memberships ?? []).length > 0) return
    // The first submission's details stay: a second one, by anyone, can't
    // change the company, the referral or the plan link.
    pending = { company: first.company, ref: first.ref, plan: first.plan ?? null }
    const firstName = (u.user_metadata as Record<string, unknown> | undefined)?.full_name
    if (typeof firstName === 'string' && firstName) fullName = firstName
    const { error: delErr } = await db.auth.admin.deleteUser(u.id)
    if (delErr) {
      console.error('[startSignup] replace stale signup:', delErr)
      return
    }
  }

  const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo,
    data: { full_name: fullName },
  })
  if (error || !data?.user) {
    console.error('[startSignup] inviteUserByEmail:', error)
    throw new AppError('We could not send the email. Try again in a moment.')
  }

  const { error: metaErr } = await db.auth.admin.updateUserById(data.user.id, {
    app_metadata: { ...(data.user.app_metadata ?? {}), pending_signup: pending },
  })
  if (metaErr) {
    console.error('[startSignup] updateUserById:', metaErr)
    throw new AppError('We could not finish the signup. Try again in a moment.')
  }
}

function readPending(user: Pick<User, 'app_metadata'>): PendingSignup | null {
  const p = (user.app_metadata as Record<string, unknown> | undefined)?.pending_signup as PendingSignup | undefined
  return p && typeof p.company === 'string' ? p : null
}

// True when the session's token says a signup is still waiting to be
// finished. Cheap (no network); completeSignup() re-checks against Supabase.
export function hasPendingSignup(user: Pick<User, 'app_metadata'>): boolean {
  return readPending(user) !== null || readPendingMcc(user) !== null
}

// An agency (MCC) invite for a new login (lib/mcc.ts inviteMcc).
function readPendingMcc(user: Pick<User, 'app_metadata'>): { inviteId: string } | null {
  const p = (user.app_metadata as Record<string, unknown> | undefined)?.pending_mcc as { inviteId?: unknown } | undefined
  return p && typeof p.inviteId === 'string' ? { inviteId: p.inviteId } : null
}

async function defaultCommissionRate(db: SupabaseClient): Promise<number> {
  const v = await getDefaultCommissionRate(db)
  if (v === null) console.error('[signup] platform_settings.default_commission_rate is not set; using 0')
  return v ?? 0
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

  // An agency invite: the MCC account is made now, with the person as owner.
  const mcc = readPendingMcc(user)
  if (mcc) {
    await acceptMccInvite(db, user, { inviteId: mcc.inviteId })
    const { error: clearErr } = await db.auth.admin.updateUserById(userId, {
      app_metadata: { ...(user.app_metadata ?? {}), pending_mcc: null },
    })
    if (clearErr) console.error('[completeSignup] clear pending_mcc:', clearErr)
    return '/agency/companies'
  }

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

  // Only with the person's yes on the password page (see the top of the file).
  if (pending.ref && pending.refConsent === true) await recordReferral(db, accountId, userId, pending.ref)
  // A custom plan's link: the plan becomes this account's (once).
  if (pending.plan) await claimPlanLink(db, pending.plan, accountId, user.email ?? '')

  const { error: clearErr } = await db.auth.admin.updateUserById(userId, {
    app_metadata: { ...(user.app_metadata ?? {}), pending_signup: null },
  })
  if (clearErr) console.error('[completeSignup] clear pending:', clearErr)

  return `/billing?account=${accountId}`
}

// Mail domains anyone can sign up with: sharing one says nothing.
const PUBLIC_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.dk', 'hotmail.com', 'hotmail.dk', 'live.com', 'live.dk',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'yahoo.com', 'yahoo.dk', 'aol.com', 'proton.me', 'protonmail.com',
  'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'mail.dk', 'jubii.dk', 'webspeed.dk', 'stofanet.dk', 'youmail.dk',
  'tdcadsl.dk', 'post.tele.dk', 'example.com',
])
const domainOf = (email: string | null | undefined) => (email ?? '').split('@')[1]?.trim().toLowerCase() || null

// A referral that may be the agency referring itself (security review, 27
// Nov): the new user's email domain is a company domain one of the agency's
// members also uses. Returns the reason to show in Admin, or null.
async function possibleSelfReferral(db: SupabaseClient, mccAccountId: string, userId: string): Promise<string | null> {
  const { data: u } = await db.auth.admin.getUserById(userId)
  const domain = domainOf(u?.user?.email)
  if (!domain || PUBLIC_MAIL.has(domain)) return null
  const { data: members } = await db.from('account_members').select('user_id').eq('account_id', mccAccountId)
  for (const m of (members ?? []) as { user_id: string }[]) {
    const { data } = await db.auth.admin.getUserById(m.user_id)
    if (domainOf(data?.user?.email) === domain) {
      return `The client signed up with an @${domain} address, the same domain as a member of the agency.`
    }
  }
  return null
}

// The agency behind a waiting signup's referral code, for the password page
// to name and ask about. Null when there's no (usable) referral.
export async function pendingReferralAgency(db: SupabaseClient, user: Pick<User, 'app_metadata'>): Promise<string | null> {
  const ref = readPending(user)?.ref
  if (!ref) return null
  const { data } = await db
    .from('referral_links')
    .select('accounts!referral_links_mcc_account_id_fkey(name, type)')
    .eq('code', ref)
    .eq('active', true)
    .maybeSingle()
  const acc = (data as unknown as { accounts: { name: string; type: string } | null } | null)?.accounts
  return acc?.type === 'mcc' ? acc.name : null
}

// Stores the person's answer about the referring agency on the waiting
// signup, before completeSignup() reads it.
export async function setReferralConsent(db: SupabaseClient, userId: string, consent: boolean): Promise<void> {
  const { data, error } = await db.auth.admin.getUserById(userId)
  if (error || !data?.user) return
  const pending = readPending(data.user)
  if (!pending?.ref) return
  const { error: upErr } = await db.auth.admin.updateUserById(userId, {
    app_metadata: { ...(data.user.app_metadata ?? {}), pending_signup: { ...pending, refConsent: consent } },
  })
  if (upErr) dbError('setReferralConsent', upErr)
}

// Referral link, agreed to → the MCC gets account access at once, and the referral is
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
  const selfReferral = await possibleSelfReferral(db, l.mcc_account_id, userId)
  const { error: rErr } = await db.from('referrals').insert({
    mcc_account_id: l.mcc_account_id,
    user_account_id: userAccountId,
    referral_link_id: l.id,
    access_grant_id: grant?.id ?? null,
    commission_rate: rate,
    // Kickback held until a platform admin approves it (migration 068).
    ...(selfReferral ? { needs_review: true, review_reason: selfReferral } : {}),
  })
  if (rErr && rErr.code !== '23505') dbError('recordReferral referral', rErr)
}
