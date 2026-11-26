'use server'

import { headers } from 'next/headers'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { createCheckout, createPortal } from '@/lib/billing'
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
