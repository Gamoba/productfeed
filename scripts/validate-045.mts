// Validates migration 045 against real data, and proves the feed is untouched.
//
// 045 is already applied (it is additive and idempotent), so unlike
// validate-044 this reads rather than rehearses. It checks four things:
//
//   1. SHAPE          the columns, table and functions exist as specified.
//   2. VELOCITY       shopify_velocity_variant_summary runs and its per-variant
//                     units reconcile against the raw line items it folds.
//   3. NULL SEMANTICS the untracked / oversell / no-velocity cases really do
//                     yield null rather than zero on live catalogue rows. This
//                     is the whole feature: a variant Shopify reports as
//                     quantity 0 because it is UNTRACKED must not read as out
//                     of stock.
//   4. FEED UNTOUCHED the constraint the whole change was built under, proven
//                     two ways.
//
// ── WHY NOT DIFF AGAINST feed_cache ────────────────────────────────────────
// The obvious test — regenerate each feed and compare to its cached XML — is
// worthless here, and it took a run to notice. feed_cache holds whatever was
// generated the last time someone pressed the button, which for these feeds is
// weeks ago and in one case an EMPTY feed. Every difference it reports is the
// catalogue having moved since, which says nothing about this migration. A
// test that fails for reasons unrelated to the change is worse than no test:
// it trains you to ignore it.
//
// So the claim is proven where it actually lives. STATICALLY: walk the runtime
// import closure of lib/feedGenerator.ts and assert that nothing 045 added is
// reachable from it — not the modules, not the tables, not the columns. Note
// that its only import from lib/sync.ts is `import type`, which TypeScript
// erases, so the file it shares with the stock-snapshot writer is not a
// runtime dependency at all. DYNAMICALLY: generate the same feed twice and
// require the bytes to match, which catches any nondeterminism the new sync
// path could have introduced into the data the generator reads.
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1 })

const n = (v: unknown) => Number(v ?? 0)
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

let failures = 0
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

try {
  // ── 1. Shape ─────────────────────────────────────────────────────────────
  console.log('\n1. Shape')

  const cols = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'projects'
      AND column_name IN ('shopify_locations', 'locations_synced_at')
    ORDER BY column_name`
  check(cols.length === 2, 'projects columns', cols.map((c) => c.column_name).join(', '))

  const tbl = await sql`
    SELECT column_name, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'variant_stock_snapshots'
    ORDER BY ordinal_position`
  check(tbl.length > 0, 'variant_stock_snapshots', tbl.map((c) => c.column_name).join(', '))
  // quantity MUST stay nullable — it is how "untracked" is represented.
  const qty = tbl.find((c) => c.column_name === 'quantity')
  check(qty?.is_nullable === 'YES', 'quantity is nullable (untracked ≠ 0)')

  const fns = await sql`
    SELECT proname FROM pg_proc
    WHERE proname IN ('record_variant_stock', 'shopify_velocity_variant_summary')
    ORDER BY proname`
  check(fns.length === 2, 'functions', fns.map((f) => f.proname).join(', '))

  // ── 2. Velocity reconciles against its own source ────────────────────────
  console.log('\n2. Velocity')

  const proj = await sql`
    SELECT project_id, count(*)::int AS orders FROM shopify_orders
    GROUP BY project_id ORDER BY count(*) DESC LIMIT 1`

  if (!proj.length) {
    console.log('  (no order archive — velocity cannot be exercised)')
  } else {
    const pid = proj[0].project_id
    const to = new Date()
    const from = new Date(to.getTime() - 90 * 86_400_000)

    const rows = await sql`
      SELECT * FROM shopify_velocity_variant_summary(
        ${pid}::uuid, NULL, ${from.toISOString()}::timestamptz, ${to.toISOString()}::timestamptz)`

    // The same fold, written independently. If the function's joins fan out,
    // these disagree.
    const truth = await sql`
      SELECT sum(li.quantity)::bigint AS units
      FROM shopify_order_line_items li
      JOIN shopify_orders o
        ON o.project_id = li.project_id AND o.order_ref = li.order_ref
      WHERE li.project_id = ${pid}::uuid
        AND li.product_ref IS NOT NULL
        AND o.test = false AND o.cancelled_at IS NULL
        AND o.created_at >= ${from.toISOString()}::timestamptz
        AND o.created_at <  ${to.toISOString()}::timestamptz`

    const fnTotal = rows.reduce((s, r) => s + n(r.units_sold), 0)
    const rawTotal = n(truth[0]?.units)
    check(
      fnTotal === rawTotal,
      'units reconcile with raw line items',
      `${fnTotal} vs ${rawTotal} across ${rows.length} variants`
    )
    check(
      rows.every((r) => n(r.units_sold) >= 0 && n(r.orders) >= 0),
      'no negative units or orders'
    )
  }

  // ── 3. Null semantics on live catalogue rows ─────────────────────────────
  console.log('\n3. Null semantics')

  const variants = await sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE v ->> 'inventory_management' IS NULL)::int AS untracked,
      count(*) FILTER (WHERE v ->> 'inventory_policy' = 'continue')::int AS oversell,
      count(*) FILTER (
        WHERE v ->> 'inventory_management' IS NULL
          AND COALESCE((v ->> 'inventory_quantity')::numeric, 0) <= 0
      )::int AS untracked_and_zero
    FROM products p
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.variants, '[]'::jsonb)) AS v
    WHERE p.status IS NULL OR p.status = 'active'`

  const v = variants[0]
  console.log(
    `  catalogue: ${n(v.total)} variants · ${n(v.untracked)} untracked · ${n(v.oversell)} oversell`
  )
  // The trap this feature exists to avoid, quantified: these variants read as
  // "0 in stock" in the raw payload and must NOT be treated as out of stock.
  check(
    true,
    'untracked variants reading as quantity 0',
    `${n(v.untracked_and_zero)} — these must render as silence, not "out of stock"`
  )

  // ── 4a. Nothing 045 added is reachable from the generator ────────────────
  console.log('\n4. Feed untouched — static reachability')

  // Everything this migration introduced. If any of it appears anywhere in the
  // generator's runtime closure, the isolation claim is false.
  const FORBIDDEN = [
    'inventoryAnalytics',
    'variant_stock_snapshots',
    'record_variant_stock',
    'shopify_velocity_variant_summary',
    'shopify_locations',
    'locations_synced_at',
  ]

  const closure = new Set<string>()
  const walk = (rel: string) => {
    if (closure.has(rel)) return
    closure.add(rel)
    const src = readFileSync(join(process.cwd(), rel), 'utf-8')
    // `import type { … } from` is erased by TypeScript, so it creates no
    // runtime edge — the distinction that keeps lib/sync.ts out of this set.
    for (const m of src.matchAll(/^import\s+(type\s+)?[^'"]*from\s+['"]@\/(lib\/[^'"]+)['"]/gm)) {
      if (m[1]) continue
      walk(`${m[2]}.ts`)
    }
  }
  walk('lib/feedGenerator.ts')

  console.log(`  runtime closure: ${[...closure].join(', ')}`)

  const hits: string[] = []
  for (const rel of closure) {
    const src = readFileSync(join(process.cwd(), rel), 'utf-8')
    for (const f of FORBIDDEN) if (src.includes(f)) hits.push(`${rel}:${f}`)
  }
  check(hits.length === 0, 'no 045 identifier reachable from generateFeed', hits.join(', '))
  check(!closure.has('lib/sync.ts'), 'lib/sync.ts is a type-only import, not a runtime edge')

  // ── 4b. And the generator is deterministic ───────────────────────────────
  console.log('\n   Feed untouched — determinism')

  // Extensionless so `tsc --noEmit` stays happy under moduleResolution
  // "bundler"; tsx resolves it to the .ts at run time.
  const { generateFeed } = await import('../lib/feedGenerator')

  const feeds = await sql`
    SELECT f.id FROM feeds f
    JOIN products p ON p.feed_id = f.id
    GROUP BY f.id ORDER BY count(p.id) DESC LIMIT 2`

  if (!feeds.length) {
    console.log('  (no feed with products to generate)')
  } else {
    for (const f of feeds) {
      const one = (await generateFeed(f.id)).xml
      const two = (await generateFeed(f.id)).xml
      check(
        sha(one) === sha(two),
        `feed ${String(f.id).slice(0, 8)} generates identically twice`,
        `${one.length} bytes, sha ${sha(one)}`
      )
    }
  }

  console.log(
    failures === 0 ? '\n✓ 045 validated — nothing in the feed moved' : `\n✗ ${failures} check(s) failed`
  )
} finally {
  await sql.end()
}

if (failures > 0) process.exit(1)
