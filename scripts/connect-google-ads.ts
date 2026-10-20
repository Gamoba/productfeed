// Configures a feed's Google Ads connection from the CLI.
//
// This is the admin path that exists BEFORE the UI does — it stores the same
// encrypted connection the OAuth callback will, so the sync and the analytics
// view can be built and verified without waiting on the browser flow.
//
// Read-only against Google; writes only to Supabase (google_ads_connections,
// google_ads_feed_settings). The refresh token is encrypted before storage and
// never printed.
//
// Usage:
//   npx tsx scripts/connect-google-ads.ts --feeds
//       list feeds in this database, with their Google Ads status
//   npx tsx scripts/connect-google-ads.ts --accounts --manager 345-856-6876
//       list the ad accounts under the MCC
//   npx tsx scripts/connect-google-ads.ts --actions --customer 393-413-9943 --manager 345-856-6876
//       list the enabled conversion actions in an account
//   npx tsx scripts/connect-google-ads.ts --feed <feedId> --customer 393-413-9943 \
//       --manager 345-856-6876 --roas "PM Revenue - All customers" \
//       --poas "PM Gross Profit - All customers" [--feed-label DK]
//       store the connection + settings for that feed
//
// The refresh token comes from GOOGLE_ADS_REFRESH_TOKEN in .env.local
// (scripts/google-ads-auth.ts mints one).

import { readFileSync } from 'fs'
import { join } from 'path'
import { adminDb } from '@/lib/feeds'
import { saveConnection, getConnection, saveFeedSettings, getFeedSettings } from '@/lib/feedGoogleAds'
import { listClientAccounts, listConversionActions, formatCustomerId, normalizeCustomerId } from '@/lib/googleAds'

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
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const has = (name: string) => argv.includes(name)
/** Every occurrence of a repeatable flag, deduped: --roas A --roas B → [A, B]. */
const flagAll = (name: string): string[] => {
  const out: string[] = []
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1])
  })
  return [...new Set(out)]
}

const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN
const MANAGER = flag('--manager') ?? '345-856-6876'

function requireToken(): string {
  if (!REFRESH_TOKEN) {
    console.error('Missing GOOGLE_ADS_REFRESH_TOKEN. Run: npx tsx scripts/google-ads-auth.ts')
    process.exit(1)
  }
  return REFRESH_TOKEN
}

async function listFeeds() {
  const db = adminDb()
  const { data: feeds, error } = await db
    .from('feeds')
    .select('id, name, user_id, project_id')
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)

  console.log(`\n${feeds?.length ?? 0} feed(s):\n`)
  for (const f of feeds ?? []) {
    const s = await getFeedSettings(db, f.id)
    const status = s?.customer_id
      ? `→ Google Ads ${formatCustomerId(s.customer_id)}${s.last_synced_at ? ` (synced ${s.last_synced_at.slice(0, 10)})` : ' (never synced)'}`
      : '→ not linked'
    console.log(`  ${f.id}  ${String(f.name).padEnd(30)} ${status}`)
    if (s?.roas_conversion_actions?.length) console.log(`      ROAS: ${s.roas_conversion_actions.join(' + ')}`)
    if (s?.poas_conversion_actions?.length) console.log(`      POAS: ${s.poas_conversion_actions.join(' + ')}`)
  }
  console.log('')
}

async function listAccounts() {
  const accounts = await listClientAccounts(
    { refreshToken: requireToken(), customerId: MANAGER, loginCustomerId: MANAGER },
    MANAGER
  )
  console.log(`\n${accounts.length} ad accounts under MCC ${MANAGER}:\n`)
  for (const a of accounts) {
    console.log(`  ${formatCustomerId(a.customerId).padEnd(14)} ${a.name.padEnd(32)} ${a.currencyCode}  ${a.timeZone}`)
  }
  console.log('')
}

async function listActions() {
  const customer = flag('--customer')
  if (!customer) {
    console.error('--actions requires --customer <id>')
    process.exit(1)
  }
  const actions = await listConversionActions({
    refreshToken: requireToken(),
    customerId: customer,
    loginCustomerId: MANAGER,
  })
  console.log(`\n${actions.length} active conversion actions in ${formatCustomerId(customer)}:\n`)
  for (const a of actions) {
    console.log(
      `  ${a.name.slice(0, 46).padEnd(48)} ${a.category.padEnd(18)} ${a.primaryForGoal ? 'PRIMARY' : 'secondary'}`
    )
  }
  console.log(
    '\n  Choose ONE for revenue (--roas) and ONE for gross profit (--poas).\n' +
      '  Note: the highest-value action is often a view_item tracker that\n' +
      '  reports the product price as "value" — do NOT choose that one.\n'
  )
}

async function connectFeed() {
  const feedId = flag('--feed')!
  const customer = flag('--customer')
  if (!customer) {
    console.error('--feed also requires --customer <id>')
    process.exit(1)
  }

  const db = adminDb()
  const { data: feed, error } = await db
    .from('feeds')
    .select('id, name, user_id')
    .eq('id', feedId)
    .maybeSingle<{ id: string; name: string; user_id: string }>()
  if (error) throw new Error(error.message)
  if (!feed) {
    console.error(`Feed ${feedId} does not exist. Run --feeds to see the list.`)
    process.exit(1)
  }

  // Verify the credentials reach the account BEFORE storing anything, so a
  // broken setup fails here rather than silently at the first sync.
  const accounts = await listClientAccounts(
    { refreshToken: requireToken(), customerId: MANAGER, loginCustomerId: MANAGER },
    MANAGER
  )
  const target = accounts.find((a) => a.customerId === normalizeCustomerId(customer))
  if (!target) {
    console.error(
      `Account ${formatCustomerId(customer)} was not found under MCC ${MANAGER}.\n` +
        'Run --accounts to see which accounts the connection can reach.'
    )
    process.exit(1)
  }

  const existing = await getConnection(db, feed.user_id)
  const connection = await saveConnection(db, feed.user_id, {
    refreshToken: requireToken(),
    loginCustomerId: MANAGER,
    accountLabel: existing?.account_label ?? `MCC ${formatCustomerId(MANAGER)}`,
  })

  const settings = await saveFeedSettings(db, feedId, {
    connection_id: connection.id,
    customer_id: target.customerId,
    customer_name: target.name,
    currency_code: target.currencyCode,
    feed_label: flag('--feed-label') ?? null,
    // Repeatable: --roas "A" --roas "B" sums both. flag() returns the first, so
    // the raw argv is read here instead.
    roas_conversion_actions: flagAll('--roas'),
    poas_conversion_actions: flagAll('--poas'),
  })

  console.log(`\n✓ ${feed.name} → ${target.name} (${formatCustomerId(target.customerId)}, ${target.currencyCode})`)
  console.log(`  connection:  ${connection.id} (token stored encrypted)`)
  console.log(`  ROAS actions:  ${settings.roas_conversion_actions?.join(' + ') || '(not selected)'}`)
  console.log(`  POAS actions:  ${settings.poas_conversion_actions?.join(' + ') || '(not selected)'}`)
  console.log(`  feed label:    ${settings.feed_label ?? '(none — whole account)'}`)
  console.log(`\nNow run:  npx tsx scripts/run-google-ads-sync.ts ${feedId}\n`)
}

async function main() {
  if (has('--feeds')) return listFeeds()
  if (has('--accounts')) return listAccounts()
  if (has('--actions')) return listActions()
  if (flag('--feed')) return connectFeed()

  console.log(readFileSync(__filename, 'utf-8').split('\n').slice(6, 26).join('\n').replace(/^\/\/ ?/gm, ''))
}

main().catch((e) => {
  console.error('\n✗', e instanceof Error ? e.message : e)
  process.exit(1)
})
