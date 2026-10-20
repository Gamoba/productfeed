// Exercises the custom-label engine from the CLI.
//
// Writes only to google_ads_custom_labels / google_ads_buckets /
// google_ads_bucket_members. Nothing here touches the generated feed —
// emit_to_feed stays false and lib/feedGenerator.ts reads none of it.
//
// Usage:
//   npx tsx scripts/run-google-ads-labels.ts <feedId>                recompute every label
//   npx tsx scripts/run-google-ads-labels.ts <feedId> --list         show labels and values only
//   npx tsx scripts/run-google-ads-labels.ts <feedId> --label <id>   recompute one label
//
// There is no --seed. The hardcoded starter set it created was removed; labels
// are defined in the UI until the real templates land.

import { readFileSync } from 'fs'
import { join } from 'path'
import { adminDb } from '@/lib/feeds'
import { getFeedSettings } from '@/lib/feedGoogleAds'
import { listLabels, listBuckets, recomputeFeed, recomputeLabel } from '@/lib/googleAdsBuckets'

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
const flagValue = (n: string) => {
  const i = argv.indexOf(n)
  return i === -1 ? undefined : argv[i + 1]
}
const has = (n: string) => argv.includes(n)
const feedId = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))

if (!feedId) {
  console.error('Usage: npx tsx scripts/run-google-ads-labels.ts <feedId> [--seed] [--list] [--label <id>]')
  console.error('Find the feed id with: npx tsx scripts/connect-google-ads.ts --feeds')
  process.exit(1)
}

const fmt = (n: number) => n.toLocaleString('da-DK')
const slotName = (slot: number | null) => (slot === null ? 'no slot' : `custom_label_${slot}`)

async function main() {
  const db = adminDb()

  const settings = await getFeedSettings(db, feedId!)
  if (!settings) {
    console.error('Google Ads is not set up for this feed.')
    process.exit(1)
  }

  const labels = await listLabels(db, feedId!)
  if (!labels.length) {
    console.log('\nNo custom labels defined for this feed. Create one on the Custom labels page.\n')
    return
  }

  if (has('--list')) {
    const buckets = await listBuckets(db, feedId!)
    const { data } = await db
      .from('google_ads_bucket_members')
      .select('bucket_id')
      .eq('feed_id', feedId!)
    const counts = new Map<string, number>()
    for (const r of (data ?? []) as { bucket_id: string }[]) {
      counts.set(r.bucket_id, (counts.get(r.bucket_id) ?? 0) + 1)
    }

    for (const l of labels) {
      console.log(
        `\n${slotName(l.slot).padEnd(15)} ${l.name}  (${l.level}, ${l.window_days}d` +
          `${l.computed_at ? '' : ', never computed'})`
      )
      for (const b of buckets.filter((x) => x.label_id === l.id)) {
        const rules = b.is_fallback
          ? 'catch-all'
          : b.rules.map((r) => `${r.metric} ${r.operator} ${r.value ?? ''}`.trim()).join(` ${b.match_type} `)
        console.log(
          `  ${String(b.is_fallback ? 'last' : b.priority).padStart(4)}  ${b.name.padEnd(18)} ` +
            `→ ${b.value.padEnd(12)} ${String(counts.get(b.id) ?? 0).padStart(5)}  ${rules}`
        )
      }
    }
    console.log('')
    return
  }

  const one = flagValue('--label')
  const result = one ? await recomputeLabel(db, feedId!, one) : await recomputeFeed(db, feedId!)

  for (const r of result.labels) {
    console.log(`\n${slotName(r.slot)} · ${r.name} — ${r.level}, ${r.windowDays}d`)
    console.log(
      `  entities   : ${fmt(r.entities)}  (${fmt(r.withData)} with Google data, ${fmt(r.entities - r.withData)} without)`
    )
    console.log(`  labelled   : ${fmt(r.assigned)}${r.unlabelled ? `  (${fmt(r.unlabelled)} carry no value)` : ''}`)
    console.log(`  changed    : ${fmt(r.moved)}`)
    console.log('')
    for (const b of r.perBucket) {
      const pct = r.entities ? ((b.count / r.entities) * 100).toFixed(0) : '0'
      const bar = '█'.repeat(Math.round((b.count / Math.max(1, r.entities)) * 24))
      console.log(`  ${b.name.padEnd(18)} → ${b.value.padEnd(12)} ${String(b.count).padStart(5)}  ${pct.padStart(3)}%  ${bar}`)
    }
    for (const w of r.warnings) console.log(`\n  ⚠ ${w}`)
  }

  for (const w of result.warnings) console.log(`\n⚠ ${w}`)
  console.log('')
}

main().catch((e) => {
  console.error('\n✗', e instanceof Error ? e.message : e)
  process.exit(1)
})
