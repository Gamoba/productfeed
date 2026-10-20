// Syncs the Shopify order archive from the CLI.
//
// This is the sync that must not lapse. The app has `read_orders` but not
// `read_all_orders`, so Shopify only shows the last 60 days — anything older
// is unreachable forever. Run this on a schedule well inside that window
// (daily is comfortable, weekly is the outer limit); a gap longer than 60 days
// is a permanent hole in the archive that no later run can repair.
//
// Writes only to shopify_orders / _order_line_items / _refunds /
// _refund_line_items / _returns / _return_line_items / _order_sync_state.
// Nothing here touches the generated feed, and no custom label reads it.
//
// Usage:
//   npx tsx scripts/run-shopify-orders.ts --projects            list connected projects
//   npx tsx scripts/run-shopify-orders.ts <projectId>           incremental sync
//   npx tsx scripts/run-shopify-orders.ts <projectId> --probe   one page, nothing written
//   npx tsx scripts/run-shopify-orders.ts <projectId> --coverage how deep the archive goes
//   npx tsx scripts/run-shopify-orders.ts <projectId> --since 2026-06-01   repair run

import { readFileSync } from 'fs'
import { join } from 'path'
import { adminDb } from '@/lib/feeds'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import { syncShopifyOrders, getArchiveCoverage } from '@/lib/shopifyOrders'

const envFile = join(process.cwd(), '.env.local')
try {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [k, ...rest] = line.split('=')
    if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
  }
} catch {
  // fall through to existing env
}

const argv = process.argv.slice(2)
const has = (n: string) => argv.includes(n)
const flagValue = (n: string) => {
  const i = argv.indexOf(n)
  return i === -1 ? undefined : argv[i + 1]
}
const projectId = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))

const fmt = (n: number) => n.toLocaleString('da-DK')

async function listProjects() {
  const db = adminDb()
  const { data } = await db
    .from('projects')
    .select('id, name, shop_url, access_token_ciphertext')
    .order('created_at', { ascending: true })

  const rows = (data ?? []) as {
    id: string
    name: string
    shop_url: string | null
    access_token_ciphertext: string | null
  }[]

  if (!rows.length) {
    console.log('\nNo projects.\n')
    return
  }

  console.log('')
  for (const p of rows) {
    const connected = p.shop_url && p.access_token_ciphertext ? p.shop_url : '— not connected'
    console.log(`  ${p.id}  ${p.name}  ${connected}`)
  }
  console.log('')
}

async function probe(id: string) {
  const db = adminDb()
  const client = await createShopifyClientForProject(db, id)

  // 59 days: the same first-run floor the sync uses, so a probe that returns
  // nothing means the store genuinely has no recent orders rather than that
  // the range was wrong.
  const since = new Date(Date.now() - 59 * 86_400_000).toISOString()
  console.log(`\nAsking Shopify for one page of orders updated since ${since} …\n`)

  const page = await client.fetchOrdersPage(since, null, 5)

  console.log(`  orders on page : ${page.orders.length}`)
  console.log(`  more pages     : ${page.hasNextPage ? 'yes' : 'no'}`)

  const withRefunds = page.orders.filter((o) => o.refunds.length)
  const withReturns = page.orders.filter((o) => o.returns.length)
  console.log(`  with refunds   : ${withRefunds.length}`)
  console.log(`  with returns   : ${withReturns.length}`)

  const sample = withRefunds[0] ?? page.orders[0]
  if (!sample) {
    console.log('\n  No orders in the window — nothing to show.\n')
    return
  }

  console.log(`\n  Sample order ${sample.name ?? sample.orderRef}`)
  console.log(`    created    : ${sample.createdAt}`)
  console.log(`    country    : ${sample.countryCode ?? '—'}`)
  console.log(`    currency   : ${sample.presentmentCurrency ?? '—'} (shop: ${sample.shopCurrency ?? '—'})`)
  console.log(`    total      : ${sample.totalPrice.presentment ?? sample.totalPrice.shop ?? '—'}`)
  console.log(`    refunded   : ${sample.totalRefunded.presentment ?? sample.totalRefunded.shop ?? '—'}`)
  console.log(`    line items : ${sample.lineItems.length}`)

  for (const li of sample.lineItems.slice(0, 3)) {
    console.log(
      `      ${li.quantity}× ${li.title ?? '—'}${li.variantTitle ? ` / ${li.variantTitle}` : ''}` +
        `  product=${li.productRef ?? '—'} variant=${li.variantRef ?? '—'}`
    )
  }

  for (const r of sample.refunds) {
    console.log(
      `    refund ${r.refundRef}: ${r.totalRefunded.presentment ?? r.totalRefunded.shop ?? '—'}` +
        `  return=${r.returnRef ?? 'none (not a return)'}  lines=${r.lineItems.length}`
    )
  }

  for (const ret of withReturns[0]?.returns ?? []) {
    console.log(`    return ${ret.returnRef}: ${ret.status ?? '—'}, ${ret.totalQuantity} unit(s)`)
    for (const rli of ret.lineItems.slice(0, 3)) {
      console.log(`      reason=${rli.returnReason ?? '—'} variant=${rli.variantRef ?? '—'}`)
    }
  }

  console.log('\n  Nothing was written — this is a read-only probe.\n')
}

async function coverage(id: string) {
  const db = adminDb()
  const c = await getArchiveCoverage(db, id)

  console.log('')
  console.log(`  oldest order : ${c.oldestOrderAt ?? '— archive is empty'}`)
  console.log(`  newest order : ${c.newestOrderAt ?? '—'}`)
  console.log(`  depth        : ${c.depthDays === null ? '—' : `${c.depthDays} days`}`)
  console.log(`  last run     : ${c.lastRunAt ?? '— never'}`)
  if (c.lastError) console.log(`  last error   : ${c.lastError}`)
  if (c.hasPermanentGap) {
    console.log(
      '\n  ⚠ The archive has not been refreshed inside Shopify\'s 60-day window.\n' +
        '    Orders have aged out unseen. That gap cannot be filled later —\n' +
        '    return rates covering it will be based on incomplete history.'
    )
  }
  console.log('')
}

async function main() {
  if (has('--projects')) return listProjects()

  if (!projectId) {
    console.error('Usage: npx tsx scripts/run-shopify-orders.ts <projectId> [--probe] [--coverage] [--since YYYY-MM-DD]')
    console.error('List projects with: npx tsx scripts/run-shopify-orders.ts --projects')
    process.exit(1)
  }

  if (has('--probe')) return probe(projectId)
  if (has('--coverage')) return coverage(projectId)

  const db = adminDb()
  const since = flagValue('--since')

  const result = await syncShopifyOrders(db, projectId, {
    since: since ? new Date(`${since}T00:00:00Z`).toISOString() : undefined,
    onProgress: (msg) => console.log(`  ${msg}`),
  })

  console.log('')
  console.log(`  orders           : ${fmt(result.orders)}`)
  console.log(`  line items       : ${fmt(result.lineItems)}`)
  console.log(`  refunds          : ${fmt(result.refunds)}`)
  console.log(`  refund lines     : ${fmt(result.refundLineItems)}`)
  console.log(`  returns          : ${fmt(result.returns)}`)
  console.log(`  return lines     : ${fmt(result.returnLineItems)}`)
  console.log(`  pages            : ${fmt(result.pages)}`)
  if (result.truncated) {
    console.log(
      `  ⚠ truncated      : ${fmt(result.truncated)} order(s) had more than 50 line items — the tail was not read.`
    )
  }
  console.log(`  watermark        : ${result.watermark ?? '—'}`)
  console.log(`  took             : ${fmt(Math.round(result.durationMs / 100) / 10)}s`)
  console.log('')
}

main().catch((err) => {
  console.error(`\n  Failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
