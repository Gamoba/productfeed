// Tests a failed renewal end to end with a Stripe test clock (test mode only).
//
//   npx tsx scripts/test-failed-payment.ts <test-login-email>
//
// 1. Makes a second account, "Billing Clock Test", owned by the given test
//    login (one made by scripts/test-signup-link.ts), so it shows in that
//    login's account picker on /billing.
// 2. Gives it a Stripe customer on a new test clock, and an Advanced monthly
//    subscription paid with a working test card.
// 3. Swaps the card for Stripe's "charge fails" test card and moves the clock
//    past the renewal date, so the renewal payment fails.
// 4. Waits for the webhook (stripe listen + the dev server must be running)
//    to bring the subscription to past_due.
//
// Clean up with: npx tsx scripts/test-signup-link.ts --cleanup <email>
// (it removes every account the test login made). The test clock and its
// customer can be deleted in Stripe → Test clocks.
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

async function waitFor<T>(what: string, check: () => Promise<T | null | undefined>, seconds = 60): Promise<T> {
  for (let i = 0; i < seconds; i++) {
    const v = await check()
    if (v) return v
    await sleep(1000)
  }
  throw new Error(`Timed out waiting for ${what}. Are the dev server and stripe listen running?`)
}

async function run() {
  const email = process.argv[2]?.trim().toLowerCase()
  if (!email) throw new Error('Usage: npx tsx scripts/test-failed-payment.ts <test-login-email>')

  const [user] = await sql`SELECT id, raw_app_meta_data->>'signup_test' AS test FROM auth.users WHERE email = ${email}`
  if (!user || user.test !== 'true') throw new Error(`${email} is not a login made by test-signup-link.ts`)

  const [price] = await sql`SELECT stripe_price_id FROM plan_prices WHERE plan_id = 'advanced' AND interval = 'month' AND NOT livemode`
  if (!price?.stripe_price_id) throw new Error('No test price for Advanced monthly. Run npm run stripe:setup.')

  // 1. The account.
  const [account] = await sql`
    INSERT INTO accounts (name, type, created_by) VALUES ('Billing Clock Test', 'user', ${user.id}) RETURNING id`
  await sql`INSERT INTO account_members (account_id, user_id, role) VALUES (${account.id}, ${user.id}, 'owner')`
  console.log('account', account.id)

  // 2. Customer on a test clock, subscribed with a working card.
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: 'FeedFlow failed-payment test',
  })
  const customer = await stripe.customers.create({
    name: 'Billing Clock Test',
    test_clock: clock.id,
    metadata: { account_id: account.id },
  })
  await sql`INSERT INTO stripe_customers (account_id, livemode, stripe_customer_id) VALUES (${account.id}, false, ${customer.id})`
  const good = await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id })
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: good.id } })

  const sub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.stripe_price_id }],
    metadata: { account_id: account.id, plan_id: 'advanced' },
  })
  console.log('subscription', sub.id, sub.status)
  await waitFor('the subscription to sync as active', async () => {
    const [r] = await sql`SELECT status FROM subscriptions WHERE stripe_subscription_id = ${sub.id}`
    return r?.status === 'active' ? r : null
  })
  console.log('synced: active')

  // 3. A card that fails, then past the renewal date.
  const bad = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: customer.id })
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: bad.id } })
  const periodEnd = sub.items.data[0].current_period_end
  await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: periodEnd + 2 * 3600 })
  console.log('clock advancing past', new Date(periodEnd * 1000).toISOString())
  await waitFor('the test clock', async () => {
    const c = await stripe.testHelpers.testClocks.retrieve(clock.id)
    return c.status === 'ready' ? c : null
  }, 120)

  // 4. The webhook brings it to past_due.
  const row = await waitFor('the subscription to sync as past_due', async () => {
    const [r] = await sql`SELECT status, current_period_end FROM subscriptions WHERE stripe_subscription_id = ${sub.id}`
    return r?.status === 'past_due' ? r : null
  })
  console.log('synced:', row.status)
  console.log(`\nPASS. On /billing, pick "Billing Clock Test" in the account menu to see the notice.`)
  console.log(`Test clock: ${clock.id}`)
}

run()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => sql.end())
