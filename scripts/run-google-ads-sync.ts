// Runs the Google Ads metrics sync for one feed from the CLI.
// Read-only against Google; writes only to google_ads_product_daily.
//
// Run:  npx tsx scripts/run-google-ads-sync.ts <feedId> [--days 90]

import { readFileSync } from 'fs'
import { join } from 'path'
import { adminDb } from '@/lib/feeds'
import { getFeedSettings } from '@/lib/feedGoogleAds'
import { syncGoogleAdsMetrics, missingSetup } from '@/lib/googleAdsSync'

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
const feedId = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--days')
const daysArg = argv.indexOf('--days') !== -1 ? Number(argv[argv.indexOf('--days') + 1]) : undefined

if (!feedId) {
  console.error('Usage: npx tsx scripts/run-google-ads-sync.ts <feedId> [--days 90]')
  console.error('Find the feed id with: npx tsx scripts/connect-google-ads.ts --feeds')
  process.exit(1)
}

async function main() {
  const db = adminDb()

  // Surface a half-configured feed as a checklist rather than as an obscure
  // failure or, worse, a silently empty ROAS column.
  const settings = await getFeedSettings(db, feedId!)
  const missing = missingSetup(settings)
  // Check the fields, not the wording: matching on message text silently
  // stops working the moment a string is reworded or translated.
  if (!settings?.connection_id || !settings?.customer_id) {
    console.error('\nThe feed is not ready:')
    for (const m of missing) console.error(`  · ${m}`)
    console.error('\nRun: npx tsx scripts/connect-google-ads.ts --feed <feedId> --customer <id>\n')
    process.exit(1)
  }
  for (const m of missing) console.log(`⚠ ${m}`)

  const r = await syncGoogleAdsMetrics(db, feedId!, { days: daysArg })

  console.log(`\n✓ Sync complete (${r.durationMs} ms)`)
  console.log(`  period       : ${r.from} → ${r.to}`)
  console.log(`  rows stored  : ${r.rows}`)
  console.log(`  unique items : ${r.itemIds}`)
  console.log(`  products     : ${r.products}`)
  console.log(`  id format    : ${r.pattern ?? 'unknown'} (${Math.round(r.patternConfidence * 100)}%)`)
  if (r.unmatched) {
    console.log(`  ⚠ ${r.unmatched} rows could not be matched to a product`)
  }
  for (const w of r.warnings) console.log(`  ⚠ ${w}`)
  console.log('')
}

main().catch((e) => {
  console.error('\n✗ Sync failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
