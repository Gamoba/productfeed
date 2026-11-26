// Creates the plans' products and prices in Stripe, and stores the price ids in
// plan_prices. Run once per mode, after migration 061:
//
//   npm run stripe:setup
//
// Uses STRIPE_SECRET_KEY from .env.local: a test key fills the test rows
// (livemode = false), a live key the live rows. Idempotent: prices are found
// by lookup key (`feedflow_<plan>_<interval>`), so running it again creates
// nothing new. Prices are tax-exclusive, as Stripe Tax needs.
//
// Live rows: insert plan_prices rows with livemode = true and the amounts
// first; this script fills only rows that exist.
import postgres from 'postgres'
import Stripe from 'stripe'
import { readFileSync } from 'fs'
import { join } from 'path'

try {
  for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const [k, ...rest] = line.split('=')
    if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
  }
} catch {
  // no .env.local: use the environment as is
}

const key = process.env.STRIPE_SECRET_KEY
if (!key || !process.env.DATABASE_URL) {
  console.error('Needs STRIPE_SECRET_KEY and DATABASE_URL in .env.local')
  process.exit(1)
}
const livemode = key.startsWith('sk_live_') || key.startsWith('rk_live_')
const stripe = new Stripe(key)
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 })

type Row = { plan_id: string; name: string; interval: 'month' | 'year'; amount_cents: number; currency: string; stripe_price_id: string | null }

async function productFor(planId: string, name: string): Promise<string> {
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    if (p.metadata?.plan_id === planId) return p.id
  }
  const p = await stripe.products.create({
    name: `FeedFlow ${name}`,
    metadata: { plan_id: planId },
    tax_code: 'txcd_10103001', // SaaS, business use
  })
  console.log(`  created product ${p.id} for ${planId}`)
  return p.id
}

async function run() {
  console.log(`Stripe ${livemode ? 'LIVE' : 'test'} mode`)
  const rows = await sql<Row[]>`
    SELECT pp.plan_id, p.name, pp.interval, pp.amount_cents, pp.currency, pp.stripe_price_id
    FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
    WHERE pp.livemode = ${livemode} AND NOT p.is_custom
    ORDER BY p.sort_order, pp.interval`
  if (rows.length === 0) console.log('No plan_prices rows for this mode.')

  for (const r of rows) {
    const lookupKey = `feedflow_${r.plan_id}_${r.interval}`
    const found = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })
    let price = found.data[0]
    if (price && (price.unit_amount !== r.amount_cents || price.currency !== r.currency)) {
      console.error(`  ${lookupKey}: Stripe has ${price.unit_amount} ${price.currency}, the database ${r.amount_cents} ${r.currency}. Fix one of them; skipped.`)
      continue
    }
    if (!price) {
      price = await stripe.prices.create({
        product: await productFor(r.plan_id, r.name),
        unit_amount: r.amount_cents,
        currency: r.currency,
        recurring: { interval: r.interval },
        tax_behavior: 'exclusive',
        lookup_key: lookupKey,
        metadata: { plan_id: r.plan_id },
      })
      console.log(`  created price ${price.id} (${lookupKey})`)
    }
    await sql`
      UPDATE plan_prices SET stripe_price_id = ${price.id}
      WHERE plan_id = ${r.plan_id} AND interval = ${r.interval} AND livemode = ${livemode}`
    console.log(`  ${r.plan_id} / ${r.interval}: ${price.id}`)
  }
}

run()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => sql.end())
