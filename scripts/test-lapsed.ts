// Puts a test account into the "plan ended" (lapsed) state with a real Stripe
// test subscription, so the lapsed Billing view and Reactivate can be tried.
// Test mode only. The dev server and `stripe listen` must be running.
//
//   npx tsx scripts/test-lapsed.ts "<account name>"
//
// 1. Creates the account's Stripe customer (if it has none) and a Standard
//    monthly subscription paid with Stripe's working test card.
// 2. Waits for the webhook to record it as active, then cancels it at once
//    and waits for the webhook to record it as canceled.
//
// Reset afterwards with:  npx tsx scripts/test-lapsed.ts --reset "<account name>"
// (removes the account's subscriptions, Stripe customer link and any shops
// and feeds it has, so it's back to "never paid").
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
const stripe = new Stripe(key)
const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitStatus(subId: string, status: string) {
  for (let i = 0; i < 60; i++) {
    const [r] = await sql`SELECT status FROM subscriptions WHERE stripe_subscription_id = ${subId}`
    if (r?.status === status) return
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${status}. Are the dev server and stripe listen running?`)
}

async function findAccount(name: string) {
  const rows = await sql`SELECT id, name, billing_exempt, type FROM accounts WHERE name = ${name}`
  if (rows.length !== 1) throw new Error(`Expected one account named "${name}", found ${rows.length}`)
  const a = rows[0]
  if (a.billing_exempt) throw new Error(`"${name}" is a free account; refusing to touch it`)
  if (a.type !== 'user') throw new Error(`"${name}" is not a User account`)
  return a as { id: string; name: string }
}

async function makeLapsed(name: string) {
  const a = await findAccount(name)
  const live = await sql`SELECT 1 FROM subscriptions WHERE account_id = ${a.id} AND status IN ('active','trialing','past_due') AND NOT livemode`
  if (live.length) throw new Error(`"${name}" already has a live plan`)
  const [price] = await sql`SELECT stripe_price_id FROM plan_prices WHERE plan_id = 'standard' AND interval = 'month' AND NOT livemode`

  let [c] = await sql`SELECT stripe_customer_id FROM stripe_customers WHERE account_id = ${a.id} AND NOT livemode`
  if (!c) {
    const customer = await stripe.customers.create({ name: a.name, metadata: { account_id: a.id } })
    await sql`INSERT INTO stripe_customers (account_id, livemode, stripe_customer_id) VALUES (${a.id}, false, ${customer.id})`
    c = { stripe_customer_id: customer.id }
    console.log('customer', customer.id)
  }
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: c.stripe_customer_id })
  await stripe.customers.update(c.stripe_customer_id, { invoice_settings: { default_payment_method: pm.id } })

  const sub = await stripe.subscriptions.create({
    customer: c.stripe_customer_id,
    items: [{ price: price.stripe_price_id }],
    metadata: { account_id: a.id, plan_id: 'standard' },
  })
  console.log('subscription', sub.id, sub.status)
  await waitStatus(sub.id, 'active')
  console.log('synced: active')
  await stripe.subscriptions.cancel(sub.id)
  await waitStatus(sub.id, 'canceled')
  console.log(`synced: canceled\n\n"${name}" is now lapsed. Open /billing as its user.`)
}

async function reset(name: string) {
  const a = await findAccount(name)
  const projects = await sql`SELECT id FROM projects WHERE account_id = ${a.id}`
  const ids = projects.map((p) => p.id as string)
  if (ids.length) {
    await sql`DELETE FROM feeds WHERE project_id IN ${sql(ids)}`
    await sql`DELETE FROM projects WHERE id IN ${sql(ids)}`
  }
  const subs = await sql`SELECT stripe_subscription_id, status FROM subscriptions WHERE account_id = ${a.id} AND NOT livemode`
  // Cancel live ones first and let the webhook record it; deleting the rows
  // before that would have the webhook write a canceled row straight back.
  for (const s of subs) {
    if (!['canceled', 'incomplete_expired'].includes(s.status)) {
      await stripe.subscriptions.cancel(s.stripe_subscription_id).catch(() => {})
      await waitStatus(s.stripe_subscription_id, 'canceled').catch(() => {})
    }
  }
  await sleep(3000)
  await sql`DELETE FROM subscriptions WHERE account_id = ${a.id}`
  await sql`DELETE FROM stripe_customers WHERE account_id = ${a.id}`
  console.log(`"${name}": removed ${ids.length} shop(s) and ${subs.length} subscription(s); back to never paid.`)
}

const args = process.argv.slice(2)
const run = args[0] === '--reset' ? reset(args[1]) : makeLapsed(args[0])
run
  .catch((e) => {
    console.error(e.message ?? e)
    process.exitCode = 1
  })
  .finally(() => sql.end())
