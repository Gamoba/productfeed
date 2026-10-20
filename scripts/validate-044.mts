// Rollback-wrapped rehearsal of migration 044.
//
// Everything DDL in Postgres is transactional, so this applies the whole
// migration, exercises every function it creates against real data, checks the
// invariant that matters, and then throws the lot away. Nothing persists.
//
// THE INVARIANT: google_ads_product_summary, google_ads_campaign_summary,
// google_ads_product_campaigns and google_ads_daily_totals all fold the SAME
// underlying rows at different grains. They must agree to the cent. If a join
// fans out — the hazard migration 037 documents and 044 had to preserve — the
// folds disagree and this fails loudly instead of shipping inflated numbers.
//
// Crucially it runs with EVERY conversion action ticked at once, because the
// rc/pc joins only execute when actions are supplied. With NULL actions those
// CTEs return nothing and the dangerous path is never tested.
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1 })

// The file carries its own BEGIN/COMMIT; strip them so the outer transaction
// stays in charge and the ROLLBACK actually reaches everything.
const body = readFileSync(
  join(process.cwd(), 'supabase/migrations/044_google_ads_campaigns.sql'),
  'utf-8'
)
  .split('\n')
  .filter((l) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/i.test(l))
  .join('\n')

const n = (v: unknown) => Number(v ?? 0)
const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d))
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)

const ROLLBACK = '__rollback__'

try {
  await sql.begin(async (tx) => {
    await tx.unsafe(body)

    const cols = await tx`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'campaign_id'
        AND table_name IN ('google_ads_product_daily', 'google_ads_product_conversions')
      ORDER BY table_name`
    console.log('campaign_id on:', cols.map((c) => c.table_name).join(', '))

    const fns = await tx`
      SELECT proname FROM pg_proc
      WHERE proname IN ('google_ads_product_summary', 'google_ads_variant_summary',
                        'google_ads_campaign_summary', 'google_ads_product_campaigns',
                        'google_ads_daily_totals', 'google_ads_synced_range')
      ORDER BY proname`
    console.log('functions:', fns.map((f) => f.proname).join(', '))

    const feed = await tx`SELECT feed_id FROM google_ads_feed_settings LIMIT 1`
    if (!feed.length) {
      console.log('(no configured feed — cannot exercise the functions)')
      throw new Error(ROLLBACK)
    }

    const id = feed[0].feed_id
    const r = await tx`SELECT * FROM google_ads_synced_range(${id}::uuid)`
    const from = iso(r[0]?.first_date)
    const to = iso(r[0]?.last_date)
    console.log(`\nfeed ${id}  archive ${from} .. ${to} (${r[0]?.days} days)\n`)

    const acts = await tx`
      SELECT DISTINCT conversion_action FROM google_ads_product_conversions
      WHERE feed_id = ${id}::uuid`
    const names = acts.map((a) => a.conversion_action as string)
    console.log(`conversion actions (${names.length}):`, JSON.stringify(names))

    // Worst case for fan-out: every action counted on BOTH sides at once.
    const A: string[] | null = names.length ? names : null

    const fold = async (label: string, rows: postgres.RowList<postgres.Row[]>) => {
      const x = rows[0]
      console.log(
        `  ${label.padEnd(18)} cost ${n(x.c).toFixed(2).padStart(12)}   revenue ${n(x.rv)
          .toFixed(2)
          .padStart(12)}   conv ${n(x.rc).toFixed(2).padStart(10)}`
      )
      return { c: n(x.c), rv: n(x.rv), rc: n(x.rc) }
    }

    console.log('\nWITH EVERY ACTION TICKED (exercises the rc/pc joins):')
    const ps = await fold(
      'product_summary',
      await tx`SELECT coalesce(sum(cost),0) c, coalesce(sum(roas_value),0) rv, coalesce(sum(roas_conversions),0) rc
               FROM google_ads_product_summary(${id}::uuid, ${from}::date, ${to}::date, ${A}, ${A})`
    )
    const cs = await fold(
      'campaign_summary',
      await tx`SELECT coalesce(sum(cost),0) c, coalesce(sum(roas_value),0) rv, coalesce(sum(roas_conversions),0) rc
               FROM google_ads_campaign_summary(${id}::uuid, ${from}::date, ${to}::date, ${A}, ${A})`
    )
    const pc = await fold(
      'product_campaigns',
      await tx`SELECT coalesce(sum(cost),0) c, coalesce(sum(roas_value),0) rv, coalesce(sum(roas_conversions),0) rc
               FROM google_ads_product_campaigns(${id}::uuid, ${from}::date, ${to}::date, NULL, ${A}, ${A})`
    )
    const dt = await fold(
      'daily_totals',
      await tx`SELECT coalesce(sum(cost),0) c, coalesce(sum(roas_value),0) rv, coalesce(sum(roas_conversions),0) rc
               FROM google_ads_daily_totals(${id}::uuid, ${from}::date, ${to}::date, ${A}, ${A})`
    )
    const vs = await fold(
      'variant_summary',
      await tx`SELECT coalesce(sum(cost),0) c, coalesce(sum(roas_value),0) rv, coalesce(sum(roas_conversions),0) rc
               FROM google_ads_variant_summary(${id}::uuid, ${from}::date, ${to}::date, NULL, ${A}, ${A})`
    )

    // Ground truth, read straight from the tables with no join at all.
    const truthConv = await tx`
      SELECT coalesce(sum(conversions_value),0) rv, coalesce(sum(conversions),0) rc
      FROM google_ads_product_conversions
      WHERE feed_id = ${id}::uuid AND date BETWEEN ${from}::date AND ${to}::date`
    const truthCost = await tx`
      SELECT coalesce(sum(cost_micros),0)::numeric / 1000000 c
      FROM google_ads_product_daily
      WHERE feed_id = ${id}::uuid AND date BETWEEN ${from}::date AND ${to}::date`
    console.log(
      `  ${'raw tables (truth)'.padEnd(18)} cost ${n(truthCost[0].c)
        .toFixed(2)
        .padStart(12)}   revenue ${n(truthConv[0].rv).toFixed(2).padStart(12)}   conv ${n(
        truthConv[0].rc
      )
        .toFixed(2)
        .padStart(10)}`
    )

    const costSpread = spread([ps.c, cs.c, pc.c, dt.c, vs.c, n(truthCost[0].c)])
    const revSpread = spread([ps.rv, cs.rv, pc.rv, dt.rv, vs.rv, n(truthConv[0].rv)])
    const convSpread = spread([ps.rc, cs.rc, pc.rc, dt.rc, vs.rc, n(truthConv[0].rc)])

    console.log('')
    console.log(costSpread < 0.01 ? '  ✓ COST agrees across all folds' : `  ✗ COST fans out by ${costSpread}`)
    console.log(revSpread < 0.01 ? '  ✓ REVENUE agrees, and matches the raw table' : `  ✗ REVENUE fans out by ${revSpread}`)
    console.log(convSpread < 0.01 ? '  ✓ CONVERSIONS agree, and match the raw table' : `  ✗ CONVERSIONS fan out by ${convSpread}`)

    if (costSpread >= 0.01 || revSpread >= 0.01 || convSpread >= 0.01) {
      throw new Error('FAN-OUT DETECTED — do not ship this migration')
    }

    throw new Error(ROLLBACK)
  })
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg !== ROLLBACK) {
    console.error('\nVALIDATION FAILED:', msg)
    await sql.end()
    process.exit(1)
  }
  console.log('\nrolled back — nothing persisted')
}

const left = await sql`
  SELECT count(*)::int AS n FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'google_ads_product_daily'
    AND column_name = 'campaign_id'`
console.log('campaign_id still present?', left[0].n > 0 ? 'YES — rollback failed' : 'no — clean')

await sql.end()
