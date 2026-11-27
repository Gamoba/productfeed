'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { clientMessage } from '@/lib/errors'
import { enforceRateLimit } from '@/lib/rateLimit'
import { requirePlatformAdmin, setDefaultCommissionRate } from '@/lib/platformAdmin'
import { inviteMcc, setAgencyRate, setKickbackOverride } from '@/lib/mcc'
import { markPayoutPaid } from '@/lib/commissions'
import { createCustomPlan, newPlanLink, setCustomPlanActive, type CustomPlanInput } from '@/lib/customPlans'
import { createAddon, grantAddon, revokeFreeAddon, setAddonActive, type AddonInput } from '@/lib/addons'

export type AdminResult = { ok?: true; error?: string; message?: string; link?: string }

// Every admin action: a fresh session check (getUser), the platform-admin
// check, and a rate limit.
async function admin() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Sign in again.')
  const db = adminDb()
  await requirePlatformAdmin(db, user.id)
  await enforceRateLimit(user.id, 'admin_action')
  return { user, db }
}

const pctToRate = (v: string) => {
  const n = Number(String(v).replace(',', '.').replace('%', '').trim())
  return Number.isFinite(n) ? n / 100 : NaN
}

async function done<T extends AdminResult>(fn: () => Promise<T>, ctx: string): Promise<AdminResult> {
  try {
    const r = await fn()
    revalidatePath('/admin')
    return r
  } catch (err) {
    return { error: err instanceof Error && err.message === 'Sign in again.' ? err.message : clientMessage(err, ctx) }
  }
}

export async function setDefaultRateAction(percent: string): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await setDefaultCommissionRate(db, user.id, pctToRate(percent))
    return { ok: true as const, message: 'Saved. New referrals get this rate.' }
  }, 'setDefaultRateAction')
}

export async function inviteMccAction(email: string, name: string): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    const h = await headers()
    const origin = h.get('origin') ?? `https://${h.get('host')}`
    const r = await inviteMcc(db, user.id, { email, name }, origin)
    return r.kind === 'emailed'
      ? { ok: true as const, message: `Invitation sent to ${email}.` }
      : { ok: true as const, message: `${email} already has a login and email isn't set up. Send them this link:`, link: r.link }
  }, 'inviteMccAction')
}

export async function setAgencyRateAction(mccId: string, percent: string): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await setAgencyRate(db, user.id, mccId, percent.trim() === '' ? null : pctToRate(percent))
    return { ok: true as const }
  }, 'setAgencyRateAction')
}

export async function setOverrideAction(referralId: string, on: boolean, note: string): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await setKickbackOverride(db, user.id, referralId, on, note.trim() || null)
    return { ok: true as const }
  }, 'setOverrideAction')
}

export async function markPaidAction(mccId: string, currency: string, reference: string): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    const r = await markPayoutPaid(db, user.id, mccId, currency, reference.trim() || null)
    return { ok: true as const, message: r.totalCents ? 'Marked as paid.' : 'Nothing was due.' }
  }, 'markPaidAction')
}

// ── Custom plans ───────────────────────────────────────────────────────────

export async function createCustomPlanAction(input: CustomPlanInput): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    const h = await headers()
    const origin = h.get('origin') ?? `https://${h.get('host')}`
    const r = await createCustomPlan(db, user.id, input, origin)
    if (!r.link) return { ok: true as const, message: 'Custom plan created. It shows on the account’s Billing page now.' }
    return {
      ok: true as const,
      message: r.emailed
        ? 'Custom plan created and the signup link was emailed. The link, in case you need it:'
        : 'Custom plan created. Send this one-time signup link to the company:',
      link: r.link,
    }
  }, 'createCustomPlanAction')
}

export async function newPlanLinkAction(planId: string, email: string): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    const h = await headers()
    const origin = h.get('origin') ?? `https://${h.get('host')}`
    const r = await newPlanLink(db, user.id, planId, email, origin)
    return { ok: true as const, message: r.emailed ? 'New link emailed. The link:' : 'New one-time signup link (the old one no longer works):', link: r.link }
  }, 'newPlanLinkAction')
}

export async function setPlanActiveAction(planId: string, active: boolean): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await setCustomPlanActive(db, user.id, planId, active)
    return { ok: true as const, message: active ? 'Plan offered again.' : 'Plan retired. Existing subscriptions on it keep running.' }
  }, 'setPlanActiveAction')
}

// ── Add-ons ────────────────────────────────────────────────────────────────

export async function createAddonAction(input: AddonInput): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await createAddon(db, user.id, input)
    return { ok: true as const, message: 'Add-on created. Customers on a plan can add it from Billing.' }
  }, 'createAddonAction')
}

export async function setAddonActiveAction(addonId: string, active: boolean): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await setAddonActive(db, user.id, addonId, active)
    return {
      ok: true as const,
      message: active ? 'Add-on offered again.' : 'Add-on retired. Accounts that have it keep it.',
    }
  }, 'setAddonActiveAction')
}

export async function grantAddonAction(
  accountId: string,
  addonId: string,
  quantity: string,
  free: boolean,
  note: string
): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await grantAddon(db, user.id, accountId, addonId, { quantity, free, note })
    return {
      ok: true as const,
      message: free ? 'Added for free: it raises their limits and bills nothing.' : 'Added to their subscription. Stripe bills the rest of the period.',
    }
  }, 'grantAddonAction')
}

export async function revokeFreeAddonAction(accountAddonId: string): Promise<AdminResult> {
  return done(async () => {
    const { user, db } = await admin()
    await revokeFreeAddon(db, user.id, accountAddonId)
    return { ok: true as const, message: 'Taken off the account.' }
  }, 'revokeFreeAddonAction')
}
