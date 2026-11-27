'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { completeSignup, pendingReferralAgency, setReferralConsent } from '@/lib/signup'
import { clientMessage } from '@/lib/errors'

// Finishes an invite: turns the tokens from the invite link into a cookie
// session, then sets the password the user chose. Runs on the server so the
// session lands in the same cookies every other page reads.
//
// The same link finishes an open signup (lib/signup.ts): then the User account
// is created here and `next` points at choosing a plan.
// The agency that referred this signup, for the page to ask about. Read from
// the invite's own access token, so it only answers for that login.
export async function inviteReferral(accessToken: string): Promise<{ agency: string | null }> {
  if (typeof accessToken !== 'string' || !accessToken) return { agency: null }
  const { data, error } = await adminDb().auth.getUser(accessToken)
  if (error || !data.user) return { agency: null }
  return { agency: await pendingReferralAgency(adminDb(), data.user) }
}

export async function acceptInvite(input: {
  accessToken: string
  refreshToken: string
  password: string
  /** The answer to "the referring agency gets access" (only asked when there is one). */
  referralConsent?: boolean
}): Promise<{ error?: string; next?: string }> {
  if (typeof input.password !== 'string' || input.password.length < 8) {
    return { error: 'The password must be at least 8 characters.' }
  }
  if (!input.accessToken || !input.refreshToken) {
    return { error: 'The link is missing details. Ask for a new one.' }
  }

  const supabase = await createSupabaseServerClient()
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
  })
  if (sessionError) return { error: 'The link has expired or has already been used. Ask for a new one.' }

  const { data, error } = await supabase.auth.updateUser({ password: input.password })
  if (error) return { error: error.message }

  try {
    if (data.user) await setReferralConsent(adminDb(), data.user.id, input.referralConsent === true)
    const next = data.user ? await completeSignup(adminDb(), data.user.id) : null
    return next ? { next } : {}
  } catch (err) {
    // The password is set and they're signed in; the home page retries.
    return { error: clientMessage(err, 'acceptInvite completeSignup') }
  }
}
