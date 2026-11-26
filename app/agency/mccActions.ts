'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { clientMessage } from '@/lib/errors'
import { enforceRateLimit } from '@/lib/rateLimit'
import { decideAccess, regenerateAccessCode, requestAccess, revokeAccess } from '@/lib/mcc'

export type ActionResult = { ok?: true; error?: string; message?: string; code?: string }

// getUser (not getClaims): granting and revoking access is sensitive, so a
// session signed out elsewhere must not still work here.
async function currentUser() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}

async function origin(): Promise<string> {
  const h = await headers()
  return h.get('origin') ?? `https://${h.get('host')}`
}

// ── Agency side ────────────────────────────────────────────────────────────

export async function requestAccessAction(mccId: string, code: string): Promise<ActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    // Codes are 10 characters, but a cap keeps anyone from guessing them.
    await enforceRateLimit(user.id, 'access_request')
    const r = await requestAccess(adminDb(), user, mccId, code, await origin())
    revalidatePath('/agency/companies')
    return {
      ok: true,
      message: r.emailed
        ? `Request sent. ${r.clientName} has been emailed and needs to approve it.`
        : `Request sent. ${r.clientName} sees it under Agency access and needs to approve it.`,
    }
  } catch (err) {
    return { error: clientMessage(err, 'requestAccessAction') }
  }
}

// ── Client side ────────────────────────────────────────────────────────────

export async function decideAccessAction(grantId: string, approve: boolean, feedId: string | null): Promise<ActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    await decideAccess(adminDb(), user.id, grantId, { approve, feedId })
    revalidatePath('/agency/access')
    return { ok: true }
  } catch (err) {
    return { error: clientMessage(err, 'decideAccessAction') }
  }
}

export async function revokeAccessAction(grantId: string): Promise<ActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    await revokeAccess(adminDb(), user.id, grantId)
    revalidatePath('/agency/access')
    return { ok: true }
  } catch (err) {
    return { error: clientMessage(err, 'revokeAccessAction') }
  }
}

export async function regenerateCodeAction(accountId: string): Promise<ActionResult> {
  try {
    const user = await currentUser()
    if (!user) return { error: 'Sign in again.' }
    const code = await regenerateAccessCode(adminDb(), user.id, accountId)
    revalidatePath('/agency/access')
    return { ok: true, code }
  } catch (err) {
    return { error: clientMessage(err, 'regenerateCodeAction') }
  }
}
