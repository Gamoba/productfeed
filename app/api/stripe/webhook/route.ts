import { stripe } from '@/lib/stripe'
import { adminDb } from '@/lib/feeds'
import { handleStripeEvent } from '@/lib/billing'

// Stripe webhook. The signature is checked against STRIPE_WEBHOOK_SECRET on
// the raw body before anything is read; an unsigned or tampered request gets
// 400 and touches nothing.
//
// Events used: checkout.session.completed, customer.subscription.created /
// updated / deleted, invoice.paid. Configure exactly these in Stripe.
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const signature = req.headers.get('stripe-signature')
  if (!secret) {
    console.error('[stripe webhook] STRIPE_WEBHOOK_SECRET is not set')
    return new Response('Not configured', { status: 503 })
  }
  if (!signature) return new Response('Missing signature', { status: 400 })

  const body = await req.text()
  let event
  try {
    event = stripe().webhooks.constructEvent(body, signature, secret)
  } catch {
    return new Response('Invalid signature', { status: 400 })
  }

  try {
    await handleStripeEvent(adminDb(), event)
    return Response.json({ received: true })
  } catch (err) {
    // 500 makes Stripe retry later. The handlers are idempotent.
    console.error('[stripe webhook] failed on', event.type, event.id, err)
    return new Response('Handler failed', { status: 500 })
  }
}
