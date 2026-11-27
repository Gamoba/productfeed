// Dry run of migration 067: builds the index in a transaction, shows the plan
// for the hot query before and after, and rolls back.
//   npx tsx scripts/dryrun-067.mts
//
// The index is really built (seconds on this table) and then thrown away, so
// run it when the database has some headroom.
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
const body = readFileSync(join(process.cwd(), 'supabase/migrations/067_products_feed_order_index.sql'), 'utf-8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')
const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1, onnotice: () => {} })
class Rollback extends Error {}
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${extra ? ` — ${extra}` : ''}`)
  if (!ok) fails++
}

// The plan for one page of the read every heavy path does.
async function plan(tx: postgres.TransactionSql, feedId: string): Promise<string> {
  const rows = await tx.unsafe(
    `EXPLAIN SELECT id, shopify_id FROM products
      WHERE feed_id = '${feedId}' AND status = 'active'
      ORDER BY created_at, id OFFSET 2000 LIMIT 250`
  )
  return (rows as unknown as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']).join('\n')
}

try {
  await sql.begin(async (tx) => {
    const [feed] = await tx`
      SELECT feed_id, count(*) AS products
      FROM products WHERE status = 'active'
      GROUP BY feed_id ORDER BY count(*) DESC LIMIT 1`
    if (!feed) {
      check('a feed with products exists to plan against', false, 'none found')
      throw new Rollback()
    }
    console.log(`Biggest feed: ${feed.products} active products\n`)

    const before = await plan(tx, feed.feed_id)
    console.log('BEFORE:\n' + before + '\n')

    const t0 = Date.now()
    await tx.unsafe(body)
    await tx.unsafe(body) // idempotent: replaying changes nothing
    console.log(`Index built in ${Date.now() - t0} ms\n`)

    const after = await plan(tx, feed.feed_id)
    console.log('AFTER:\n' + after + '\n')

    check('the page was sorted before', /Sort/i.test(before))
    check('the index is used after', /idx_products_feed_active_order/.test(after))
    check('no sort is left after', !/Sort/i.test(after), after.split('\n')[0])

    const [{ n }] = await tx`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE tablename = 'products' AND indexname = 'idx_products_feed_active_order'`
    check('the index exists once', n === 1)

    throw new Rollback()
  })
} catch (e) {
  if (!(e instanceof Rollback)) { console.error('DRY RUN FAILED:', e); fails++ } else console.log('Rolled back.')
} finally { await sql.end() }
console.log(fails ? `${fails} FAILED` : 'PASS')
