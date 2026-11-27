// Dry run of migration 066: twice in a transaction, checks, rolls back.
//   npx tsx scripts/dryrun-066.mts
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
const body = readFileSync(join(process.cwd(), 'supabase/migrations/066_sku_usage_and_addons.sql'), 'utf-8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')
const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1, onnotice: () => {} })
class Rollback extends Error {}
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${extra ? ` — ${extra}` : ''}`)
  if (!ok) fails++
}
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(body)
    await tx.unsafe(body) // idempotent: replaying changes nothing
    check('migration replays', true)

    for (const t of ['shop_sku_usage', 'sku_charges', 'addons', 'addon_prices', 'account_addons']) {
      const [r] = await tx`SELECT relrowsecurity r FROM pg_class WHERE relname = ${t}`
      check(`${t} has RLS`, r?.r === true)
    }

    // A real shop with feeds and products, to check the counting function.
    const [feed] = await tx`
      SELECT f.id AS feed_id, p.id AS project_id, p.account_id, count(pr.id) AS products
      FROM feeds f
      JOIN projects p ON p.id = f.project_id
      JOIN products pr ON pr.feed_id = f.id AND pr.status = 'active'
      GROUP BY f.id, p.id, p.account_id
      HAVING count(pr.id) > 0
      ORDER BY count(pr.id) DESC
      LIMIT 1`
    if (!feed) {
      check('a feed with products exists to count', false, 'none found; counting not checked')
    } else {
      // Product mode: one SKU per product that goes out.
      const spec = JSON.stringify([{ feed_id: feed.feed_id, mode: 'product', ids: null }])
      const [all] = await tx`SELECT * FROM public.shop_sku_usage_count(${spec}::jsonb)`
      check('counts every active product of a feed', Number(all.product_count) === Number(feed.products),
        `${all.product_count} products, ${all.sku_count} SKUs`)
      check('a product-mode feed sends one item per product', Number(all.sku_count) === Number(all.product_count),
        `${all.sku_count} SKUs`)

      // Variant mode: one SKU per variant, so never fewer than in product mode.
      const varSpec = JSON.stringify([{ feed_id: feed.feed_id, mode: 'variant', ids: null }])
      const [variants] = await tx`SELECT * FROM public.shop_sku_usage_count(${varSpec}::jsonb)`
      const [{ vs }] = await tx`
        SELECT coalesce(sum(jsonb_array_length(coalesce(variants, '[]'::jsonb))), 0) AS vs
        FROM products WHERE feed_id = ${feed.feed_id} AND status = 'active'`
      check('a variant-mode feed sends one item per variant', Number(variants.sku_count) === Number(vs),
        `${variants.sku_count} SKUs against ${vs} variants`)

      // Mode is per feed, and the mode missing means product mode.
      const noMode = JSON.stringify([{ feed_id: feed.feed_id, ids: null }])
      const [defaulted] = await tx`SELECT * FROM public.shop_sku_usage_count(${noMode}::jsonb)`
      check('no mode given means product mode', Number(defaulted.sku_count) === Number(all.sku_count))

      const ids = await tx`SELECT shopify_id FROM products WHERE feed_id = ${feed.feed_id} AND status = 'active' LIMIT 3`
      const some = JSON.stringify([{ feed_id: feed.feed_id, mode: 'product', ids: ids.map((r) => r.shopify_id) }])
      const [few] = await tx`SELECT * FROM public.shop_sku_usage_count(${some}::jsonb)`
      check('an id list counts only those products', Number(few.product_count) === ids.length,
        `${few.product_count} of ${ids.length}`)

      // The same feed twice stands in for two feeds of one shop: the products
      // must be counted once (de-duplication per shop).
      const twice = JSON.stringify([
        { feed_id: feed.feed_id, mode: 'product', ids: null },
        { feed_id: feed.feed_id, mode: 'product', ids: null },
      ])
      const [dedup] = await tx`SELECT * FROM public.shop_sku_usage_count(${twice}::jsonb)`
      check('a product in two feeds counts once', Number(dedup.sku_count) === Number(all.sku_count))

      // Two feeds of one shop, one per variant: the product counts as the most
      // any one feed sends out, not the sum.
      const mixed = JSON.stringify([
        { feed_id: feed.feed_id, mode: 'product', ids: null },
        { feed_id: feed.feed_id, mode: 'variant', ids: null },
      ])
      const [both] = await tx`SELECT * FROM public.shop_sku_usage_count(${mixed}::jsonb)`
      check('a product in a product feed and a variant feed counts its variants once',
        Number(both.sku_count) === Math.max(Number(variants.sku_count), Number(all.sku_count)),
        `${both.sku_count} SKUs`)

      const [empty] = await tx`SELECT * FROM public.shop_sku_usage_count('[]'::jsonb)`
      check('no feeds counts zero', Number(empty.product_count) === 0 && Number(empty.sku_count) === 0)

      // A usage row, a charge row, an add-on and a grant.
      await tx`INSERT INTO shop_sku_usage (project_id, measured_on, account_id, sku_count, product_count, feed_count)
               VALUES (${feed.project_id}, current_date, ${feed.account_id}, ${Number(variants.sku_count)}, ${Number(all.product_count)}, 1)`
      await tx`INSERT INTO shop_sku_usage (project_id, measured_on, account_id, sku_count, product_count, feed_count)
               VALUES (${feed.project_id}, current_date, ${feed.account_id}, 1, 1, 1)
               ON CONFLICT (project_id, measured_on) DO UPDATE SET sku_count = 1`
      const [u] = await tx`SELECT sku_count FROM shop_sku_usage WHERE project_id = ${feed.project_id} AND measured_on = current_date`
      check('one usage row per shop per day, re-measuring updates it', u.sku_count === 1)

      await tx`INSERT INTO sku_charges (account_id, period_month, interval, peak_skus, included_skus,
                 extra_thousands, rate_per_1000_cents, amount_cents, livemode)
               VALUES (${feed.account_id}, date_trunc('month', current_date)::date, 'month', 7000, 5000, 2, 270, 540, false)`
      await tx.unsafe('SAVEPOINT s')
      let refused = false
      try {
        await tx`INSERT INTO sku_charges (account_id, period_month, interval, peak_skus, included_skus,
                   extra_thousands, rate_per_1000_cents, amount_cents, livemode)
                 VALUES (${feed.account_id}, date_trunc('month', current_date)::date, 'month', 7000, 5000, 2, 270, 540, false)`
      } catch { refused = true; await tx.unsafe('ROLLBACK TO SAVEPOINT s') }
      check('an account is charged once per month and mode', refused)

      await tx`INSERT INTO addons (id, name, quantity_enabled, feed_delta) VALUES ('addon-dryrun', 'Extra feeds', true, 5)`
      await tx`INSERT INTO addon_prices (addon_id, interval, livemode, amount_cents) VALUES ('addon-dryrun', 'month', false, 1500)`
      await tx`INSERT INTO account_addons (account_id, addon_id, quantity, interval, livemode, stripe_subscription_item_id)
               VALUES (${feed.account_id}, 'addon-dryrun', 2, 'month', false, 'si_dryrun')`
      await tx.unsafe('SAVEPOINT s2')
      refused = false
      try {
        await tx`INSERT INTO account_addons (account_id, addon_id, quantity, interval, livemode)
                 VALUES (${feed.account_id}, 'addon-dryrun', 1, 'month', false)`
      } catch { refused = true; await tx.unsafe('ROLLBACK TO SAVEPOINT s2') }
      check('an account has one live row per add-on', refused)

      await tx`UPDATE account_addons SET status = 'removed', removed_at = now() WHERE stripe_subscription_item_id = 'si_dryrun'`
      await tx`INSERT INTO account_addons (account_id, addon_id, quantity, interval, livemode, free, granted_by)
               VALUES (${feed.account_id}, 'addon-dryrun', 1, NULL, false, true, NULL)`
      check('a removed add-on can be granted again, free', true)

      await tx.unsafe('SAVEPOINT s3')
      refused = false
      try {
        await tx`INSERT INTO account_addons (account_id, addon_id, livemode, free, stripe_subscription_item_id)
                 VALUES (${feed.account_id}, 'addon-dryrun', false, true, 'si_free')`
      } catch { refused = true; await tx.unsafe('ROLLBACK TO SAVEPOINT s3') }
      check('a free add-on carries no Stripe item', refused)
    }

    throw new Rollback()
  })
} catch (e) {
  if (!(e instanceof Rollback)) { console.error('DRY RUN FAILED:', e); fails++ } else console.log('Rolled back.')
} finally { await sql.end() }
console.log(fails ? `${fails} FAILED` : 'PASS')
