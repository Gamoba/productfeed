'use server'

import { headers } from 'next/headers'
import { adminDb } from '@/lib/feeds'
import { startSignup } from '@/lib/signup'
import { enforceRateLimit, ipRateKey } from '@/lib/rateLimit'
import { clientMessage } from '@/lib/errors'

export type SignupState = { status: 'idle' | 'sent'; error: string | null; email?: string }

// Sends the "confirm your email" invite. Limited per IP, since the person
// isn't signed in yet.
export async function signUp(_prev: SignupState, formData: FormData): Promise<SignupState> {
  try {
    const h = await headers()
    const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown'
    await enforceRateLimit(ipRateKey(ip), 'signup')

    const origin = h.get('origin') ?? `https://${h.get('host')}`
    const email = String(formData.get('email') ?? '')
    await startSignup(
      adminDb(),
      {
        name: formData.get('name'),
        company: formData.get('company'),
        email,
        ref: formData.get('ref'),
      },
      `${origin}/auth/invite`
    )
    return { status: 'sent', error: null, email: email.trim().toLowerCase() }
  } catch (err) {
    return { status: 'idle', error: clientMessage(err, 'signUp') }
  }
}
