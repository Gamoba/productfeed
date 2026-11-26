// Checks the webhook's two guards against a running dev server:
//   1. a request with a wrong signature is refused (400) and changes nothing;
//   2. a real Stripe event delivered twice is handled once: both answers are
//      200, and the billing rows are the same before and after.
//
//   npx tsx scripts/test-webhook-replay.ts [http://localhost:3000]
//
// Test mode only. Signs with STRIPE_WEBHOOK_SECRET from .env.local, as
// `stripe listen` does.
import postgres from 'postgres'
import Stripe from 'stripe'
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
const key = process.env.STRIPE_SECRET_KEY ?? ''
if (!key.startsWith('sk_test_')) {
  console.error('Test keys only.')
  process.exit(1)
}
const secret = process.env.STRIPE_WEBHOOK_SECRET!
const url = `${process.argv[2] ?? 'http://localhost:3000'}/api/stripe/webhook`
const stripe = new Stripe(key)
const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1 })

const snapshot = async () =>
  JSON.stringify(
    await sql`SELECT
      (SELECT count(*) FROM stripe_events)::int AS events,
      (SELECT count(*) FROM subscriptions)::int AS subs,
      (SELECT string_agg(stripe_subscription_id || ':' || status || ':' || plan_id, ',' ORDER BY stripe_subscription_id) FROM subscriptions) AS sub_state,
      (SELECT count(*) FROM stripe_customers)::int AS customers`
  )

async function post(payload: string, signature: string) {
  const r = await fetch(url, { method: 'POST', headers: { 'stripe-signature': signature, 'content-type': 'application/json' }, body: payload })
  return `${r.status} ${await r.text()}`
}

async function run() {
  let ok = true
  const before = await snapshot()

  // 1. Wrong signature.
  const fake = JSON.stringify({ id: 'evt_fake', type: 'customer.subscription.deleted', livemode: false, data: { object: {} } })
  const bad = await post(fake, `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`)
  console.log('wrong signature  →', bad)
  if (!bad.startsWith('400')) ok = false

  // 2. The newest recorded event, delivered twice.
  const [row] = await sql`SELECT id, type FROM stripe_events WHERE NOT livemode ORDER BY processed_at DESC LIMIT 1`
  if (!row) throw new Error('No recorded test events yet. Do a test checkout first.')
  const event = await stripe.events.retrieve(row.id)
  const payload = JSON.stringify(event)
  for (const n of [1, 2]) {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret })
    const res = await post(payload, header)
    console.log(`${row.type} (${row.id}) delivery ${n} →`, res)
    if (!res.startsWith('200')) ok = false
  }

  const after = await snapshot()
  console.log('rows unchanged   →', before === after ? 'yes' : `NO\n  before ${before}\n  after  ${after}`)
  if (before !== after) ok = false
  console.log(ok ? '\nPASS' : '\nFAIL')
  process.exitCode = ok ? 0 : 1
}

run()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => sql.end())
