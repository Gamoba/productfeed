// The Stripe client. Server-side only: STRIPE_SECRET_KEY is never sent to the
// browser or logged. Checkout and the customer portal are Stripe-hosted, so
// the app needs no publishable key.
//
// Test and live data share one database (docs/billing-brief.md §1), so every
// billing row carries `livemode` and the app only acts on rows that match the
// key in use (stripeLivemode()).

import Stripe from 'stripe'
import { AppError } from '@/lib/errors'

let client: Stripe | null = null

export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new AppError('Billing is not set up yet. Try again later.', 503)
  if (!client) client = new Stripe(key)
  return client
}

export function billingConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

// True for live keys (sk_live_ / rk_live_), false for test keys.
export function stripeLivemode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  return key.startsWith('sk_live_') || key.startsWith('rk_live_')
}
