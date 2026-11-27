'use server'

import { headers } from 'next/headers'
import { adminDb } from '@/lib/feeds'
import { startSignup } from '@/lib/signup'
import { emailRateKey, enforceRateLimit, ipRateKey } from '@/lib/rateLimit'
import { clientMessage } from '@/lib/errors'

export type SignupState = { status: 'idle' | 'sent'; error: string | null; email?: string }

// Sends the "confirm your email" invite. Limited per IP (IPv6 per /64), since
// the person isn't signed in yet, and per email address, so nobody can flood
// one inbox or use up the project's email quota. Both refuse when the limiter
// is down.
export async function signUp(_prev: SignupState, formData: FormData): Promise<SignupState> {
  try {
    const h = await headers()
    const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown'
    await enforceRateLimit(ipRateKey(ip), 'signup', 1, { failClosed: true })

    const origin = h.get('origin') ?? `https://${h.get('host')}`
    const email = String(formData.get('email') ?? '')
    await enforceRateLimit(emailRateKey(email), 'signup_email', 1, { failClosed: true })
    await startSignup(
      adminDb(),
      {
        name: formData.get('name'),
        company: formData.get('company'),
        email,
        ref: formData.get('ref'),
        plan: formData.get('plan'),
      },
      `${origin}/auth/invite`
    )
    return { status: 'sent', error: null, email: email.trim().toLowerCase() }
  } catch (err) {
    return { status: 'idle', error: clientMessage(err, 'signUp') }
  }
}
