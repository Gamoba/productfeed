'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { createCheckout, createPortal } from '@/lib/billing'
import { buyAddon, removeAddon } from '@/lib/addons'
import { enforceRateLimit } from '@/lib/rateLimit'
import { clientMessage } from '@/lib/errors'

export type BillingActionResult = { url?: string; error?: string }

async function origin(): Promise<string> {
  const h = await headers()
  return h.get('origin') ?? `https://${h.get('host')}`
}

// getUser (not getClaims): billing is sensitive, so a session signed out
// elsewhere must not still work here.
async function currentUser() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

export async function startCheckout(accountId: string, planId: string, interval: string): Promise<BillingActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    await enforceRateLimit(user.id, 'billing_session')
    return { url: await createCheckout(adminDb(), user, accountId, planId, interval, await origin()) }
  } catch (err) {
    return { error: clientMessage(err, 'startCheckout') }
  }
}

export async function openPortal(accountId: string): Promise<BillingActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    await enforceRateLimit(user.id, 'billing_session')
    return { url: await createPortal(adminDb(), user, accountId, await origin()) }
  } catch (err) {
    return { error: clientMessage(err, 'openPortal') }
  }
}

// ── Add-ons ────────────────────────────────────────────────────────────────

export type AddonActionResult = { ok?: true; error?: string }

export async function addAddonAction(accountId: string, addonId: string, quantity: string): Promise<AddonActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    await enforceRateLimit(user.id, 'billing_session')
    await buyAddon(adminDb(), user.id, accountId, addonId, quantity)
    revalidatePath('/billing')
    return { ok: true }
  } catch (err) {
    return { error: clientMessage(err, 'addAddonAction') }
  }
}

export async function removeAddonAction(accountId: string, addonId: string): Promise<AddonActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    await enforceRateLimit(user.id, 'billing_session')
    await removeAddon(adminDb(), user.id, accountId, addonId)
    revalidatePath('/billing')
    return { ok: true }
  } catch (err) {
    return { error: clientMessage(err, 'removeAddonAction') }
  }
}
