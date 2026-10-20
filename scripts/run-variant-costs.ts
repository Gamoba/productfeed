// Pulls "Cost per item" for every variant in a feed and reports coverage.
//
// Read-only towards Shopify: unitCost comes back from a GraphQL `query`.
//
// Usage:
//   npx tsx scripts/run-variant-costs.ts <feedId>          sync, then report
//   npx tsx scripts/run-variant-costs.ts <feedId> --report  report only

import { readFileSync } from 'fs'
import { join } from 'path'
import { adminDb } from '@/lib/feeds'
import { syncVariantCosts, getProductMargins, marginCoverage } from '@/lib/variantCosts'

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
const feedId = argv.find((a) => !a.startsWith('--'))
const reportOnly = argv.includes('--report')

if (!feedId) {
  console.error('Usage: npx tsx scripts/run-variant-costs.ts <feedId> [--report]')
  process.exit(1)
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`

async function main() {
  const db = adminDb()

  if (!reportOnly) {
    const r = await syncVariantCosts(db, feedId!)
    console.log(
      `\nSynced — ${r.products} products, ${r.variants} variants, ` +
        `${r.costed} with a cost (${r.variants ? pct(r.costed / r.variants) : '0%'}) in ${r.durationMs}ms`
    )
  }

  const margins = await getProductMargins(db, feedId!)
  const cov = marginCoverage(margins)

  console.log(`\nCoverage`)
  console.log(`  products with a margin : ${cov.withMargin} of ${cov.products}`)
  console.log(`  variants with a cost   : ${cov.variantsCosted} of ${cov.variants}`)

  const known = [...margins.values()]
    .filter((m) => m.margin !== null)
    .sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0))

  if (!known.length) {
    console.log('\nNo product has both a price and a cost yet.')
    return
  }

  // Titles only for what we print, not for the whole catalogue.
  const refs = [...known.slice(0, 8), ...known.slice(-8)].map((m) => m.productRef)
  const { data } = await db
    .from('products')
    .select('shopify_id, title')
    .eq('feed_id', feedId!)
    .in('shopify_id', refs)
  const titles = new Map(
    ((data ?? []) as { shopify_id: string; title: string | null }[]).map((p) => [
      p.shopify_id,
      p.title ?? '',
    ])
  )

  const line = (m: (typeof known)[number]) =>
    `  ${pct(m.margin ?? 0).padStart(5)}  price ${m.priceSum.toFixed(0).padStart(7)}  ` +
    `cost ${m.costSum.toFixed(0).padStart(7)}  ${m.variantsCosted}/${m.variantsTotal} variants  ` +
    `${(titles.get(m.productRef) ?? m.productRef).slice(0, 46)}`

  console.log(`\nThinnest margins`)
  for (const m of known.slice(0, 8)) console.log(line(m))
  console.log(`\nFattest margins`)
  for (const m of known.slice(-8).reverse()) console.log(line(m))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
