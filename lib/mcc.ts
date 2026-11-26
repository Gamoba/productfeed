// Agencies (MCC accounts) and their clients (docs/billing-data-model.md).
//
//   - MCC signup: only by a platform admin's invite. A new login gets
//     Supabase's invite email (pending_mcc in app_metadata, finished in
//     lib/signup.ts); an existing login gets an app email with a one-time
//     link (/mcc/accept?token=…). Only the token's hash is stored.
//   - Referral link: /signup?ref=<code>. Signing up through it gives the
//     agency whole-account access and the kickback (lib/signup.ts).
//   - Access code: each User account has one. An agency enters it, the
//     client's owners and admins are asked (in the app, and by email), and
//     one of them approves, choosing the whole account or one feed.
//   - Revoking the referring agency's access stops the kickback; granting it
//     again resumes it (decisions 9, 16, 27).
//
// Takes the service-role client; callers check the session user first.

import { createHash, randomBytes } from 'crypto'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { getAccountRole } from '@/lib/accounts'
import { requirePlatformAdmin } from '@/lib/platformAdmin'
import { dropFutureParts } from '@/lib/commissions'
import { sendEmail } from '@/lib/email'
import { newAccessCode } from '@/lib/accessCode'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE_DAYS = 7
const hash = (t: string) => createHash('sha256').update(t).digest('hex')
const canManage = (r: string | null) => r === 'owner' || r === 'admin'

async function requireManager(db: SupabaseClient, userId: string, accountId: string): Promise<void> {
  const role = await getAccountRole(db, userId, accountId)
  if (!role) throw new AppError('The account does not exist', 404)
  if (!canManage(role)) throw new AppError('Only owners and admins can do this', 403)
}

async function requireMccMember(db: SupabaseClient, userId: string, mccId: string): Promise<{ name: string }> {
  const [{ data: acc, error }, role] = await Promise.all([
    db.from('accounts').select('name, type').eq('id', mccId).maybeSingle<{ name: string; type: string }>(),
    getAccountRole(db, userId, mccId),
  ])
  if (error) dbError('requireMccMember', error)
  if (!acc || acc.type !== 'mcc' || !role) throw new AppError('The agency account does not exist', 404)
  return { name: acc.name }
}

// Owners' and admins' email addresses, for notices.
async function managerEmails(db: SupabaseClient, accountId: string): Promise<string[]> {
  const { data, error } = await db.rpc('account_member_profiles', { p_account_id: accountId })
  if (error) {
    console.error('[mcc] managerEmails:', error)
    return []
  }
  return ((data ?? []) as { email: string | null; role: string }[])
    .filter((m) => canManage(m.role) && m.email)
    .map((m) => m.email as string)
}

// ── Referral link ──────────────────────────────────────────────────────────

const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const newRefCode = () => Array.from(randomBytes(8), (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('')

export async function ensureReferralLink(db: SupabaseClient, mccId: string): Promise<string> {
  const { data, error } = await db
    .from('referral_links')
    .select('code')
    .eq('mcc_account_id', mccId)
    .eq('active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ code: string }>()
  if (error) dbError('ensureReferralLink', error)
  if (data) return data.code
  for (let i = 0; i < 3; i++) {
    const code = newRefCode()
    const { error: insErr } = await db.from('referral_links').insert({ mcc_account_id: mccId, code })
    if (!insErr) return code
    if (insErr.code !== '23505') dbError('ensureReferralLink insert', insErr)
  }
  throw new AppError('The referral link could not be created. Try again.')
}

// ── MCC invites (platform admin) ───────────────────────────────────────────

export type InviteResult = { kind: 'emailed' } | { kind: 'link'; link: string }

export async function inviteMcc(
  db: SupabaseClient,
  adminId: string,
  input: { email: unknown; name: unknown },
  origin: string
): Promise<InviteResult> {
  await requirePlatformAdmin(db, adminId)
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : ''
  if (!EMAIL_RE.test(email)) throw new AppError('Enter a valid email address')
  if (!name) throw new AppError('Enter the agency’s name')

  const token = randomBytes(32).toString('base64url')
  const { data: invite, error } = await db
    .from('mcc_signup_invites')
    .insert({
      email,
      name,
      token_hash: hash(token),
      created_by: adminId,
      expires_at: new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString(),
    })
    .select('id')
    .single<{ id: string }>()
  if (error) dbError('inviteMcc insert', error)

  const { data: existingId, error: lookupErr } = await db.rpc('auth_user_id_by_email', { p_email: email })
  if (lookupErr) dbError('inviteMcc lookup', lookupErr)

  if (!existingId) {
    // New login: Supabase's invite email; the password page finishes it.
    const { data, error: invErr } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: `${origin}/auth/invite` })
    if (invErr || !data?.user) {
      console.error('[inviteMcc] inviteUserByEmail:', invErr)
      throw new AppError('The invitation email could not be sent. Try again.')
    }
    const { error: metaErr } = await db.auth.admin.updateUserById(data.user.id, {
      app_metadata: { ...(data.user.app_metadata ?? {}), pending_mcc: { inviteId: invite!.id } },
    })
    if (metaErr) dbError('inviteMcc meta', metaErr)
    return { kind: 'emailed' }
  }

  // Existing login: a one-time link they open while signed in.
  const link = `${origin}/mcc/accept?token=${token}`
  const sent = await sendEmail({
    to: [email],
    subject: `${name} is invited to Kompara as an agency`,
    paragraphs: [
      `You're invited to set up ${name} as an agency on Kompara. As an agency you manage your clients' product feeds and earn a share of what the clients you refer pay.`,
      `Sign in with this email address and open the link below. It works once and for ${INVITE_DAYS} days.`,
    ],
    button: { label: 'Set up the agency', url: link },
  })
  return sent ? { kind: 'emailed' } : { kind: 'link', link }
}

type InviteRow = { id: string; email: string; name: string | null; expires_at: string; used_at: string | null }

// Turns an invite into an MCC account with the user as owner. `by` is the
// invite id (from a new login's app_metadata) or the token (existing login).
export async function acceptMccInvite(
  db: SupabaseClient,
  user: Pick<User, 'id' | 'email'>,
  by: { inviteId: string } | { token: string }
): Promise<string> {
  const q = db.from('mcc_signup_invites').select('id, email, name, expires_at, used_at')
  const { data, error } = await ('inviteId' in by ? q.eq('id', by.inviteId) : q.eq('token_hash', hash(by.token))).maybeSingle<InviteRow>()
  if (error) dbError('acceptMccInvite read', error)
  if (!data) throw new AppError('The invitation does not exist. Ask Gamoba for a new one.', 404)
  if (data.used_at) throw new AppError('The invitation has already been used.')
  if (new Date(data.expires_at) < new Date()) throw new AppError('The invitation has expired. Ask Gamoba for a new one.')
  if ((user.email ?? '').toLowerCase() !== data.email.toLowerCase()) {
    throw new AppError(`The invitation is for ${data.email}. Sign in with that address.`, 403)
  }

  // Claim it first, so a double click can't make two agencies.
  const { data: claimed, error: cErr } = await db
    .from('mcc_signup_invites')
    .update({ used_at: new Date().toISOString() })
    .eq('id', data.id)
    .is('used_at', null)
    .select('id')
  if (cErr) dbError('acceptMccInvite claim', cErr)
  if (!claimed?.length) throw new AppError('The invitation has already been used.')

  const { data: acc, error: aErr } = await db
    .from('accounts')
    .insert({ name: data.name || data.email, type: 'mcc', created_by: user.id })
    .select('id')
    .single<{ id: string }>()
  if (aErr) dbError('acceptMccInvite account', aErr)
  const { error: mErr } = await db.from('account_members').insert({ account_id: acc!.id, user_id: user.id, role: 'owner' })
  if (mErr) dbError('acceptMccInvite member', mErr)
  await db.from('mcc_signup_invites').update({ mcc_account_id: acc!.id }).eq('id', data.id)
  await ensureReferralLink(db, acc!.id)
  return acc!.id
}

// ── Access codes ───────────────────────────────────────────────────────────

export async function getAccessCode(db: SupabaseClient, userId: string, accountId: string): Promise<string> {
  await requireManager(db, userId, accountId)
  const { data, error } = await db.from('accounts').select('access_code, type').eq('id', accountId).single<{ access_code: string | null; type: string }>()
  if (error) dbError('getAccessCode', error)
  if (data.type !== 'user') throw new AppError('Only customer accounts have an access code')
  return data.access_code ?? newCodeFor(db, accountId)
}

export async function regenerateAccessCode(db: SupabaseClient, userId: string, accountId: string): Promise<string> {
  await requireManager(db, userId, accountId)
  return newCodeFor(db, accountId)
}

async function newCodeFor(db: SupabaseClient, accountId: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const code = newAccessCode()
    const { error } = await db.from('accounts').update({ access_code: code }).eq('id', accountId)
    if (!error) return code
    if (error.code !== '23505') dbError('newCodeFor', error)
  }
  throw new AppError('A new code could not be made. Try again.')
}

// An agency enters a client's access code: a pending request, and the
// client's owners and admins are told.
export async function requestAccess(
  db: SupabaseClient,
  user: Pick<User, 'id'>,
  mccId: string,
  rawCode: unknown,
  origin: string
): Promise<{ clientName: string; emailed: boolean }> {
  const mcc = await requireMccMember(db, user.id, mccId)
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase().replace(/[\s-]/g, '') : ''
  if (code.length < 6) throw new AppError('Enter the code the company gave you')

  const { data: client, error } = await db
    .from('accounts')
    .select('id, name, type')
    .eq('access_code', code)
    .maybeSingle<{ id: string; name: string; type: string }>()
  if (error) dbError('requestAccess lookup', error)
  if (!client || client.type !== 'user') throw new AppError('No company has that code. Check it with the company.')

  const { data: open, error: oErr } = await db
    .from('access_grants')
    .select('status')
    .eq('user_account_id', client.id)
    .eq('mcc_account_id', mccId)
    .in('status', ['pending', 'active'])
  if (oErr) dbError('requestAccess open', oErr)
  if ((open ?? []).some((g) => g.status === 'active')) {
    // A feed-only grant may be widened: refuse only a whole-account duplicate.
    const { count } = await db
      .from('access_grants')
      .select('id', { count: 'exact', head: true })
      .eq('user_account_id', client.id)
      .eq('mcc_account_id', mccId)
      .eq('status', 'active')
      .eq('scope', 'account')
    if ((count ?? 0) > 0) throw new AppError(`You already have access to ${client.name}.`)
  }
  if ((open ?? []).some((g) => g.status === 'pending')) throw new AppError(`You've already asked ${client.name}. They need to approve it.`)

  const { error: insErr } = await db.from('access_grants').insert({
    user_account_id: client.id,
    mcc_account_id: mccId,
    scope: 'account',
    source: 'access_code',
    status: 'pending',
    requested_by: user.id,
  })
  if (insErr?.code === '23505') throw new AppError(`You've already asked ${client.name}.`)
  if (insErr) dbError('requestAccess insert', insErr)

  const emailed = await sendEmail({
    to: await managerEmails(db, client.id),
    subject: `${mcc.name} asks for access to ${client.name} on Kompara`,
    paragraphs: [
      `${mcc.name} has asked for access to ${client.name}'s product feeds on Kompara, using your access code.`,
      `Approve it to let them work on all your shops, or on one feed only. Nothing changes until you approve.`,
    ],
    button: { label: 'Review the request', url: `${origin}/agency/access` },
  })
  return { clientName: client.name, emailed }
}

type GrantRow = { id: string; user_account_id: string; mcc_account_id: string; status: string; scope: string }

async function loadGrant(db: SupabaseClient, grantId: string): Promise<GrantRow> {
  const { data, error } = await db
    .from('access_grants')
    .select('id, user_account_id, mcc_account_id, status, scope')
    .eq('id', grantId)
    .maybeSingle<GrantRow>()
  if (error) dbError('loadGrant', error)
  if (!data) throw new AppError('The request does not exist', 404)
  return data
}

// The client approves (choosing the whole account or one feed) or declines.
export async function decideAccess(
  db: SupabaseClient,
  userId: string,
  grantId: string,
  decision: { approve: boolean; feedId?: string | null }
): Promise<void> {
  const g = await loadGrant(db, grantId)
  await requireManager(db, userId, g.user_account_id)
  if (g.status !== 'pending') throw new AppError('The request has already been answered')

  if (!decision.approve) {
    const { error } = await db.from('access_grants').update({ status: 'declined', decided_by: userId }).eq('id', g.id)
    if (error) dbError('decideAccess decline', error)
    return
  }

  let scope: 'account' | 'feed' = 'account'
  let feedId: string | null = null
  if (decision.feedId) {
    const { data: f, error } = await db
      .from('feeds')
      .select('id, projects!inner(account_id)')
      .eq('id', decision.feedId)
      .eq('projects.account_id', g.user_account_id)
      .maybeSingle()
    if (error) dbError('decideAccess feed', error)
    if (!f) throw new AppError('That feed is not in your account')
    scope = 'feed'
    feedId = decision.feedId
  }
  const { error } = await db
    .from('access_grants')
    .update({ status: 'active', scope, feed_id: feedId, decided_by: userId, accepted_at: new Date().toISOString() })
    .eq('id', g.id)
  if (error?.code === '23505') throw new AppError('The agency already has that access')
  if (error) dbError('decideAccess approve', error)

  // Access again for the agency that referred this client: the kickback
  // resumes from the next paid invoice (decision 16).
  const { error: rErr } = await db
    .from('referrals')
    .update({ status: 'active', stopped_at: null, stop_reason: null })
    .eq('user_account_id', g.user_account_id)
    .eq('mcc_account_id', g.mcc_account_id)
    .eq('status', 'stopped')
    .eq('stop_reason', 'access_revoked')
    .not('first_paid_at', 'is', null)
  if (rErr) dbError('decideAccess resume referral', rErr)
}

// The client takes access away. If that was the referring agency's last
// access, its kickback stops and parts not yet due are dropped.
export async function revokeAccess(db: SupabaseClient, userId: string, grantId: string): Promise<void> {
  const g = await loadGrant(db, grantId)
  await requireManager(db, userId, g.user_account_id)
  if (g.status !== 'active') throw new AppError('The agency has no access to take away')
  const { error } = await db
    .from('access_grants')
    .update({ status: 'revoked', revoked_by: userId, revoked_at: new Date().toISOString() })
    .eq('id', g.id)
  if (error) dbError('revokeAccess', error)

  const { count } = await db
    .from('access_grants')
    .select('id', { count: 'exact', head: true })
    .eq('user_account_id', g.user_account_id)
    .eq('mcc_account_id', g.mcc_account_id)
    .eq('status', 'active')
  if ((count ?? 0) > 0) return
  const { data: ref, error: rErr } = await db
    .from('referrals')
    .update({ status: 'stopped', stopped_at: new Date().toISOString(), stop_reason: 'access_revoked' })
    .eq('user_account_id', g.user_account_id)
    .eq('mcc_account_id', g.mcc_account_id)
    .in('status', ['active', 'pending'])
    .eq('kickback_override', false)
    .select('id')
  if (rErr) dbError('revokeAccess referral', rErr)
  for (const r of (ref ?? []) as { id: string }[]) await dropFutureParts(db, { referralId: r.id })
}

// ── Page data ──────────────────────────────────────────────────────────────

const nameMap = async (db: SupabaseClient, ids: string[]) => {
  if (!ids.length) return new Map<string, string>()
  const { data } = await db.from('accounts').select('id, name').in('id', ids)
  return new Map(((data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]))
}

const feedLabels = async (db: SupabaseClient, ids: string[]) => {
  if (!ids.length) return new Map<string, string>()
  const { data } = await db.from('feeds').select('id, name, projects(name)').in('id', ids)
  return new Map(
    ((data ?? []) as unknown as { id: string; name: string; projects: { name: string } | null }[]).map((f) => [
      f.id,
      `${f.projects?.name ?? ''} · ${f.name}`,
    ])
  )
}

export type ClientAccess = {
  account: { id: string; name: string; code: string; canManage: boolean }
  pending: { id: string; agency: string; requestedAt: string }[]
  agencies: { id: string; agency: string; scope: 'account' | 'feed'; feed: string | null; since: string | null; referred: boolean }[]
  feeds: { id: string; label: string }[]
}

// The client side (Agency access page) for one User account.
export async function getClientAccess(db: SupabaseClient, userId: string, accountId: string): Promise<ClientAccess> {
  const role = await getAccountRole(db, userId, accountId)
  if (!role) throw new AppError('The account does not exist', 404)
  const manage = canManage(role)
  const [{ data: acc }, { data: grants, error }, { data: refs }, { data: feeds }] = await Promise.all([
    db.from('accounts').select('id, name, access_code').eq('id', accountId).single<{ id: string; name: string; access_code: string | null }>(),
    db
      .from('access_grants')
      .select('id, mcc_account_id, status, scope, feed_id, created_at, accepted_at')
      .eq('user_account_id', accountId)
      .in('status', ['pending', 'active'])
      .order('created_at', { ascending: false }),
    db.from('referrals').select('mcc_account_id').eq('user_account_id', accountId),
    db.from('feeds').select('id, name, projects!inner(account_id, name)').eq('projects.account_id', accountId),
  ])
  if (error) dbError('getClientAccess grants', error)
  type G = { id: string; mcc_account_id: string; status: string; scope: 'account' | 'feed'; feed_id: string | null; created_at: string; accepted_at: string | null }
  const rows = (grants ?? []) as G[]
  const names = await nameMap(db, [...new Set(rows.map((g) => g.mcc_account_id))])
  const labels = await feedLabels(db, rows.map((g) => g.feed_id).filter((x): x is string => !!x))
  const referrer = new Set(((refs ?? []) as { mcc_account_id: string }[]).map((r) => r.mcc_account_id))
  return {
    account: {
      id: accountId,
      name: acc?.name ?? '',
      code: manage ? (acc?.access_code ?? (await newCodeFor(db, accountId))) : '',
      canManage: manage,
    },
    pending: rows
      .filter((g) => g.status === 'pending')
      .map((g) => ({ id: g.id, agency: names.get(g.mcc_account_id) ?? '—', requestedAt: g.created_at })),
    agencies: rows
      .filter((g) => g.status === 'active')
      .map((g) => ({
        id: g.id,
        agency: names.get(g.mcc_account_id) ?? '—',
        scope: g.scope,
        feed: g.feed_id ? (labels.get(g.feed_id) ?? null) : null,
        since: g.accepted_at,
        referred: referrer.has(g.mcc_account_id),
      })),
    feeds: ((feeds ?? []) as unknown as { id: string; name: string; projects: { name: string } }[]).map((f) => ({
      id: f.id,
      label: `${f.projects.name} · ${f.name}`,
    })),
  }
}

export type AgencyClients = {
  agency: { id: string; name: string }
  clients: { grantId: string; accountId: string; name: string; scope: 'account' | 'feed'; feed: { id: string; label: string } | null; since: string | null; shops: number; referred: boolean }[]
  pending: { grantId: string; name: string; requestedAt: string }[]
}

// The agency side (Connected companies page).
export async function getAgencyClients(db: SupabaseClient, userId: string, mccId: string): Promise<AgencyClients> {
  const mcc = await requireMccMember(db, userId, mccId)
  const [{ data: grants, error }, { data: refs }] = await Promise.all([
    db
      .from('access_grants')
      .select('id, user_account_id, status, scope, feed_id, created_at, accepted_at')
      .eq('mcc_account_id', mccId)
      .in('status', ['pending', 'active'])
      .order('accepted_at', { ascending: false }),
    db.from('referrals').select('user_account_id').eq('mcc_account_id', mccId),
  ])
  if (error) dbError('getAgencyClients', error)
  type G = { id: string; user_account_id: string; status: string; scope: 'account' | 'feed'; feed_id: string | null; created_at: string; accepted_at: string | null }
  const rows = (grants ?? []) as G[]
  const accIds = [...new Set(rows.map((g) => g.user_account_id))]
  const names = await nameMap(db, accIds)
  const labels = await feedLabels(db, rows.map((g) => g.feed_id).filter((x): x is string => !!x))
  const shopCount = new Map<string, number>()
  if (accIds.length) {
    const { data: projects } = await db.from('projects').select('account_id').in('account_id', accIds)
    for (const p of (projects ?? []) as { account_id: string }[]) shopCount.set(p.account_id, (shopCount.get(p.account_id) ?? 0) + 1)
  }
  const referred = new Set(((refs ?? []) as { user_account_id: string }[]).map((r) => r.user_account_id))
  return {
    agency: { id: mccId, name: mcc.name },
    clients: rows
      .filter((g) => g.status === 'active')
      .map((g) => ({
        grantId: g.id,
        accountId: g.user_account_id,
        name: names.get(g.user_account_id) ?? '—',
        scope: g.scope,
        feed: g.feed_id ? { id: g.feed_id, label: labels.get(g.feed_id) ?? 'Feed' } : null,
        since: g.accepted_at,
        shops: shopCount.get(g.user_account_id) ?? 0,
        referred: referred.has(g.user_account_id),
      })),
    pending: rows
      .filter((g) => g.status === 'pending')
      .map((g) => ({ grantId: g.id, name: names.get(g.user_account_id) ?? '—', requestedAt: g.created_at })),
  }
}

export type PartnerOverview = {
  agency: { id: string; name: string; rate: number | null }
  referralCode: string
  referrals: { name: string; status: string; rate: number; firstPaidAt: string | null; signedUpAt: string }[]
  dueCents: number
  upcomingCents: number
  paidCents: number
  currency: string
  payouts: { paidAt: string; totalCents: number; currency: string; reference: string | null }[]
}

// The agency's kickbacks (Partner levels page).
export async function getPartnerOverview(db: SupabaseClient, userId: string, mccId: string, defaultRate: number | null): Promise<PartnerOverview> {
  const mcc = await requireMccMember(db, userId, mccId)
  const code = await ensureReferralLink(db, mccId)
  const [{ data: acc }, { data: refs }, { data: comms }, { data: payouts }] = await Promise.all([
    db.from('accounts').select('commission_rate').eq('id', mccId).single<{ commission_rate: number | string | null }>(),
    db.from('referrals').select('id, user_account_id, status, commission_rate, first_paid_at, signed_up_at').eq('mcc_account_id', mccId).order('signed_up_at', { ascending: false }),
    db.from('commissions').select('commission_cents, currency, payable_on, payout_id, status, referrals!inner(mcc_account_id)').eq('referrals.mcc_account_id', mccId).in('status', ['scheduled', 'reversed']),
    db.from('commission_payouts').select('paid_at, total_cents, currency, reference').eq('mcc_account_id', mccId).order('paid_at', { ascending: false }),
  ])
  type R = { id: string; user_account_id: string; status: string; commission_rate: number | string; first_paid_at: string | null; signed_up_at: string }
  const refRows = (refs ?? []) as R[]
  const names = await nameMap(db, refRows.map((r) => r.user_account_id))
  const day = new Date().toISOString().slice(0, 10)
  let due = 0, upcoming = 0, paid = 0, currency = 'eur'
  for (const c of (comms ?? []) as { commission_cents: number; currency: string; payable_on: string; payout_id: string | null }[]) {
    currency = c.currency
    if (c.payout_id) paid += c.commission_cents
    else if (c.payable_on <= day) due += c.commission_cents
    else upcoming += c.commission_cents
  }
  const own = acc?.commission_rate
  return {
    agency: { id: mccId, name: mcc.name, rate: own !== null && own !== undefined ? Number(own) : defaultRate },
    referralCode: code,
    referrals: refRows.map((r) => ({
      name: names.get(r.user_account_id) ?? '—',
      status: r.status,
      rate: Number(r.commission_rate),
      firstPaidAt: r.first_paid_at,
      signedUpAt: r.signed_up_at,
    })),
    dueCents: due,
    upcomingCents: upcoming,
    paidCents: paid,
    currency,
    payouts: ((payouts ?? []) as { paid_at: string; total_cents: number; currency: string; reference: string | null }[]).map((p) => ({
      paidAt: p.paid_at,
      totalCents: p.total_cents,
      currency: p.currency,
      reference: p.reference,
    })),
  }
}

// ── Admin ──────────────────────────────────────────────────────────────────

export type AdminOverview = {
  invites: { id: string; email: string; name: string | null; createdAt: string; expiresAt: string; usedAt: string | null }[]
  agencies: { id: string; name: string; rate: number | null; clients: number; referrals: number; code: string | null }[]
  referrals: { id: string; agency: string; client: string; status: string; stopReason: string | null; override: boolean; note: string | null; rate: number }[]
}

export async function getAdminOverview(db: SupabaseClient, adminId: string): Promise<AdminOverview> {
  await requirePlatformAdmin(db, adminId)
  const [{ data: invites }, { data: mccs }, { data: grants }, { data: refs }, { data: links }] = await Promise.all([
    db.from('mcc_signup_invites').select('id, email, name, created_at, expires_at, used_at').order('created_at', { ascending: false }).limit(50),
    db.from('accounts').select('id, name, commission_rate').eq('type', 'mcc').order('created_at'),
    db.from('access_grants').select('mcc_account_id, user_account_id').eq('status', 'active'),
    db.from('referrals').select('id, mcc_account_id, user_account_id, status, stop_reason, kickback_override, override_note, commission_rate').order('signed_up_at', { ascending: false }),
    db.from('referral_links').select('mcc_account_id, code').eq('active', true),
  ])
  type Ref = { id: string; mcc_account_id: string; user_account_id: string; status: string; stop_reason: string | null; kickback_override: boolean; override_note: string | null; commission_rate: number | string }
  const refRows = (refs ?? []) as Ref[]
  const names = await nameMap(db, [...new Set(refRows.flatMap((r) => [r.mcc_account_id, r.user_account_id]))])
  const clientsOf = new Map<string, Set<string>>()
  for (const g of (grants ?? []) as { mcc_account_id: string; user_account_id: string }[]) {
    if (!clientsOf.has(g.mcc_account_id)) clientsOf.set(g.mcc_account_id, new Set())
    clientsOf.get(g.mcc_account_id)!.add(g.user_account_id)
  }
  const codeOf = new Map(((links ?? []) as { mcc_account_id: string; code: string }[]).map((l) => [l.mcc_account_id, l.code]))
  return {
    invites: ((invites ?? []) as { id: string; email: string; name: string | null; created_at: string; expires_at: string; used_at: string | null }[]).map((i) => ({
      id: i.id, email: i.email, name: i.name, createdAt: i.created_at, expiresAt: i.expires_at, usedAt: i.used_at,
    })),
    agencies: ((mccs ?? []) as { id: string; name: string; commission_rate: number | string | null }[]).map((m) => ({
      id: m.id,
      name: m.name,
      rate: m.commission_rate === null ? null : Number(m.commission_rate),
      clients: clientsOf.get(m.id)?.size ?? 0,
      referrals: refRows.filter((r) => r.mcc_account_id === m.id).length,
      code: codeOf.get(m.id) ?? null,
    })),
    referrals: refRows.map((r) => ({
      id: r.id,
      agency: names.get(r.mcc_account_id) ?? '—',
      client: names.get(r.user_account_id) ?? '—',
      status: r.status,
      stopReason: r.stop_reason,
      override: r.kickback_override,
      note: r.override_note,
      rate: Number(r.commission_rate),
    })),
  }
}

export async function setAgencyRate(db: SupabaseClient, adminId: string, mccId: string, rate: number | null): Promise<void> {
  await requirePlatformAdmin(db, adminId)
  if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1)) throw new AppError('The rate must be between 0 % and 100 %')
  const { error } = await db.from('accounts').update({ commission_rate: rate }).eq('id', mccId).eq('type', 'mcc')
  if (error) dbError('setAgencyRate', error)
}

// Switches a referral's kickback back on (or off again), whatever its access
// (decision 9: depends on the deal with the agency).
export async function setKickbackOverride(db: SupabaseClient, adminId: string, referralId: string, on: boolean, note: string | null): Promise<void> {
  await requirePlatformAdmin(db, adminId)
  const { error } = await db
    .from('referrals')
    .update({
      kickback_override: on,
      override_by: adminId,
      override_at: new Date().toISOString(),
      override_note: note?.slice(0, 500) || null,
    })
    .eq('id', referralId)
  if (error) dbError('setKickbackOverride', error)
}
