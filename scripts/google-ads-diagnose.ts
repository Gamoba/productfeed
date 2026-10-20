// Read-only diagnostic against the Google Ads API. THROWAWAY — this exists to
// answer four questions before we design anything:
//
//   1. Does the developer token actually read a PRODUCTION account?
//      (i.e. is Basic access wired up correctly end to end)
//   2. Which API version is current? (probed, not assumed)
//   3. Does shopping_performance_view return Performance Max product data, or
//      only Shopping? — decides whether a product-labelling feature has data at
//      all for a typical Shopify advertiser.
//   4. Do segments.product_item_id values MATCH this app's g:id?
//      feedGenerator emits shopify_id (product mode) or shopify_id_variantid
//      (variant mode). If Merchant Center is fed by Shopify's own Google channel
//      app instead, ids look like shopify_DK_1234_5678 and every join is empty.
//
// Writes nothing, anywhere. Google Ads is queried read-only (GAQL SELECT only);
// Supabase is read-only too.
//
// Run:  npx tsx scripts/google-ads-diagnose.ts [clientCustomerId] [managerCustomerId]
// Defaults to Vinnu (537-571-6745) under the Gamoba MCC (345-856-6876).
//
// Flags:
//   --days N     lookback window (default 90; 30 is too short to judge a small
//                catalogue — most items get single-digit clicks)
//   --accounts   enumerate every account under the MCC and show its channel mix,
//                then exit. Use this to find an account that actually runs
//                Performance Max, since question 3 can't be answered on an
//                account that has none.

import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'

const envFile = join(process.cwd(), '.env.local')
try {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [k, ...rest] = line.split('=')
    if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
  }
} catch {
  // fall through to existing env
}

const DEV_TOKEN = process.env.GOOGLE_DEVELOPER_TOKEN
// Must resolve to the SAME client that minted the refresh token — a refresh
// token is bound to its OAuth client. Kept identical to google-ads-auth.ts.
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.CLIENT_SECRET
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN

const argv = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const hasFlag = (name: string) => argv.includes(name)
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))

const digits = (s: string) => s.replace(/\D/g, '')
const CUSTOMER_ID = digits(positional[0] ?? '537-571-6745')
const MANAGER_ID = digits(positional[1] ?? '345-856-6876')
const DAYS = Math.max(1, Number(flagValue('--days') ?? 90))
const LIST_ACCOUNTS = hasFlag('--accounts')

// Explicit date range rather than DURING LAST_30_DAYS, so --days is honoured.
// Ends yesterday: today is partial and would understate every metric.
function dateRange(days: number): { start: string; end: string } {
  const DAY = 86_400_000
  const end = new Date(Date.now() - DAY)
  const start = new Date(end.getTime() - (days - 1) * DAY)
  const f = (d: Date) => d.toISOString().slice(0, 10)
  return { start: f(start), end: f(end) }
}
const { start: DATE_START, end: DATE_END } = dateRange(DAYS)
const DATE_WHERE = `segments.date BETWEEN '${DATE_START}' AND '${DATE_END}'`

if (!DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Missing GOOGLE_DEVELOPER_TOKEN and/or GOOGLE_OAUTH_CLIENT_ID / _SECRET ' +
      '(or CLIENT_ID / CLIENT_SECRET) in .env.local'
  )
  process.exit(1)
}
if (!REFRESH_TOKEN) {
  console.error('Missing GOOGLE_ADS_REFRESH_TOKEN. Run first:  npx tsx scripts/google-ads-auth.ts')
  process.exit(1)
}

// Versions are deprecated on a rolling schedule, so probe rather than hardcode.
// Override with GOOGLE_ADS_API_VERSION if you already know the right one.
const VERSIONS = process.env.GOOGLE_ADS_API_VERSION
  ? [process.env.GOOGLE_ADS_API_VERSION]
  : ['v24', 'v23', 'v22', 'v21', 'v20', 'v19', 'v18']

const line = () => console.log('─'.repeat(72))
const num = (v: unknown) => (v === undefined || v === null ? 0 : Number(v))
const money = (micros: unknown) => num(micros) / 1_000_000
const fmt = (n: number, d = 2) =>
  n.toLocaleString('da-DK', { minimumFractionDigits: d, maximumFractionDigits: d })

// ── Auth ─────────────────────────────────────────────────────────────────────

async function accessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      refresh_token: REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }).toString(),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) throw new Error(`Token refresh ${res.status}: ${JSON.stringify(json)}`)
  return json.access_token as string
}

// ── API plumbing ─────────────────────────────────────────────────────────────

type Row = Record<string, Record<string, unknown>>

function headers(token: string, login?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'developer-token': DEV_TOKEN!,
    'Content-Type': 'application/json',
  }
  // Required whenever the authenticated user reaches the account THROUGH a
  // manager account rather than owning it directly.
  if (login) h['login-customer-id'] = login
  return h
}

// Surfaces the Google error payload, which carries the actually-useful enum
// (DEVELOPER_TOKEN_NOT_APPROVED, USER_PERMISSION_DENIED, ...) rather than just
// an HTTP status.
function explain(status: number, body: unknown): string {
  try {
    const b = body as { error?: { message?: string; details?: unknown[] } }
    const msg = b?.error?.message ?? ''
    const details = JSON.stringify(b?.error?.details ?? [])
    return `${status} ${msg} ${details}`.trim()
  } catch {
    return `${status} ${String(body)}`
  }
}

async function gaql(
  version: string,
  token: string,
  customerId: string,
  loginId: string | undefined,
  query: string
): Promise<Row[]> {
  const res = await fetch(
    `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`,
    { method: 'POST', headers: headers(token, loginId), body: JSON.stringify({ query }) }
  )
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(explain(res.status, json))
  // searchStream returns a JSON ARRAY of chunks, each { results: [...] }.
  const chunks = (Array.isArray(json) ? json : [json]) as { results?: Row[] }[]
  return chunks.flatMap((c) => c.results ?? [])
}

// ── 1. Version probe + token sanity ──────────────────────────────────────────

async function probeVersion(token: string): Promise<string> {
  const errors: string[] = []
  for (const v of VERSIONS) {
    const res = await fetch(`https://googleads.googleapis.com/${v}/customers:listAccessibleCustomers`, {
      headers: headers(token),
    })
    if (res.ok) {
      const json = (await res.json()) as { resourceNames?: string[] }
      console.log(`✓ API version:            ${v}`)
      console.log(`✓ Developer token virker mod produktionskonti`)
      const ids = (json.resourceNames ?? []).map((r) => r.split('/').pop())
      console.log(`  Accessible accounts:    ${ids.length ? ids.join(', ') : '(none)'}`)
      return v
    }
    const body = await res.json().catch(() => null)
    errors.push(`  ${v}: ${explain(res.status, body)}`)
    // A 401/403 is an auth/token problem, not a version problem — stop early.
    if (res.status === 401 || res.status === 403) break
  }
  console.error('✗ Could not call listAccessibleCustomers:')
  errors.forEach((e) => console.error(e))
  console.error(
    '\n  DEVELOPER_TOKEN_NOT_APPROVED  → tokenet har kun testadgang\n' +
      '  USER_PERMISSION_DENIED        → the signed-in user cannot access the account\n' +
      '  403 with no enum              → Google Ads API not enabled in the Cloud project'
  )
  process.exit(1)
}

// ── 2. Account context ───────────────────────────────────────────────────────

async function accountInfo(version: string, token: string) {
  line()
  console.log('ACCOUNT')
  line()

  try {
    const rows = await gaql(
      version,
      token,
      CUSTOMER_ID,
      MANAGER_ID,
      `SELECT customer.id, customer.descriptive_name, customer.currency_code,
              customer.time_zone, customer.manager, customer.test_account
       FROM customer LIMIT 1`
    )
    const c = rows[0]?.customer ?? {}
    console.log(`  Name:                   ${c.descriptiveName ?? '?'}`)
    console.log(`  ID:                     ${c.id ?? CUSTOMER_ID}`)
    console.log(`  Currency:               ${c.currencyCode ?? '?'}`)
    console.log(`  Time zone:              ${c.timeZone ?? '?'}`)
    console.log(`  Test account:           ${c.testAccount ? 'YES (!)' : 'no'}`)
    return String(c.currencyCode ?? '')
  } catch (e) {
    console.error(`  ✗ Could not read account info: ${e instanceof Error ? e.message : e}`)
    return ''
  }
}

// ── 3. Campaign mix (what SHOULD be visible) ─────────────────────────────────

type Agg = { cost: number; impr: number; clicks: number; conv: number; value: number }
const emptyAgg = (): Agg => ({ cost: 0, impr: 0, clicks: 0, conv: 0, value: 0 })
function add(a: Agg, r: Record<string, unknown>) {
  a.cost += money(r.costMicros)
  a.impr += num(r.impressions)
  a.clicks += num(r.clicks)
  a.conv += num(r.conversions)
  a.value += num(r.conversionsValue)
}

async function campaignMix(version: string, token: string, cur: string): Promise<Map<string, Agg>> {
  line()
  console.log(`CAMPAIGN TYPES (${DATE_START} → ${DATE_END}, whole account)`)
  line()
  const byType = new Map<string, Agg>()
  try {
    const rows = await gaql(
      version,
      token,
      CUSTOMER_ID,
      MANAGER_ID,
      `SELECT campaign.advertising_channel_type, metrics.impressions, metrics.clicks,
              metrics.cost_micros, metrics.conversions, metrics.conversions_value
       FROM campaign WHERE ${DATE_WHERE}`
    )
    for (const r of rows) {
      const t = String(r.campaign?.advertisingChannelType ?? 'UNKNOWN')
      if (!byType.has(t)) byType.set(t, emptyAgg())
      add(byType.get(t)!, r.metrics ?? {})
    }
    if (!byType.size) console.log('  (no data in this period)')
    for (const [t, a] of [...byType].sort((x, y) => y[1].cost - x[1].cost)) {
      console.log(
        `  ${t.padEnd(24)} spend ${fmt(a.cost).padStart(12)} ${cur}   ` +
          `conv.value ${fmt(a.value).padStart(12)}   clicks ${a.clicks}`
      )
    }
  } catch (e) {
    console.error(`  ✗ ${e instanceof Error ? e.message : e}`)
  }
  return byType
}

// ── 3b. Conversion tracking ──────────────────────────────────────────────────
// ROAS and POAS are ENTIRELY derived from conversion value. If it is zero the
// whole feature degrades to "everything is a zombie", so this has to be checked
// before anything is built on top of it.
//
// The key tell: metrics.conversions counts only actions marked as primary goals,
// while metrics.all_conversions counts every tracked action. conversions = 0 with
// all_conversions > 0 is the classic "tracking works, goals misconfigured" case
// — a settings fix, not missing data.
async function conversionHealth(version: string, token: string, cur: string) {
  line()
  console.log(`CONVERSION TRACKING (${DATE_START} → ${DATE_END})`)
  line()

  try {
    const rows = await gaql(
      version,
      token,
      CUSTOMER_ID,
      MANAGER_ID,
      `SELECT metrics.conversions, metrics.conversions_value,
              metrics.all_conversions, metrics.all_conversions_value
       FROM customer WHERE ${DATE_WHERE}`
    )
    let conv = 0
    let convVal = 0
    let all = 0
    let allVal = 0
    for (const r of rows) {
      conv += num(r.metrics?.conversions)
      convVal += num(r.metrics?.conversionsValue)
      all += num(r.metrics?.allConversions)
      allVal += num(r.metrics?.allConversionsValue)
    }
    console.log(`  Conversions (primary goals):  ${fmt(conv, 1)}   value ${fmt(convVal)} ${cur}`)
    console.log(`  All conversions:              ${fmt(all, 1)}   value ${fmt(allVal)} ${cur}`)

    if (conv === 0 && all > 0) {
      console.log('\n  ⚠ Tracking WORKS, but no action counts as a primary goal.')
      console.log('    → ROAS will be 0 for everything. Fix the account conversion goals.')
    } else if (conv === 0 && all === 0) {
      console.log('\n  ⚠ NO conversions at all in this period.')
      console.log('    → Either genuinely zero sales, or tracking is missing entirely.')
      console.log('    → A bucket engine on this data would put EVERYTHING in "loser".')
    } else if (convVal === 0 && conv > 0) {
      console.log('\n  ⚠ Conversions with no VALUE — counts are tracked, not revenue.')
      console.log('    → ROAS/POAS are impossible. Value-based tracking is required.')
    } else {
      console.log('\n  ✓ Value-based tracking appears to work.')
    }
  } catch (e) {
    console.error(`  ✗ ${e instanceof Error ? e.message : e}`)
  }

  // Which conversion actions exist, and which count toward "Conversions".
  try {
    const acts = await gaql(
      version,
      token,
      CUSTOMER_ID,
      MANAGER_ID,
      `SELECT conversion_action.name, conversion_action.category,
              conversion_action.status, conversion_action.primary_for_goal
       FROM conversion_action WHERE conversion_action.status = 'ENABLED'`
    )
    if (!acts.length) {
      console.log('\n  No active conversion actions found.')
      return
    }
    console.log('\n  Active conversion actions:')
    for (const a of acts) {
      const c = a.conversionAction ?? {}
      const primary = c.primaryForGoal === false ? 'secondary' : 'PRIMARY'
      console.log(`    ${String(c.name ?? '?').slice(0, 40).padEnd(42)} ${String(c.category ?? '')} [${primary}]`)
    }
  } catch (e) {
    console.log(`\n  (could not read conversion actions: ${e instanceof Error ? e.message.slice(0, 120) : e})`)
  }
}

// ── 3c. Enumerate the MCC ────────────────────────────────────────────────────
// "We will have multiple projects" — so the useful question isn't just what one
// account looks like, but which account is representative enough to design
// against (specifically: which ones run Performance Max).
const SCAN_CAP = 25

async function listAccounts(version: string, token: string) {
  line()
  console.log(`ACCOUNTS UNDER MCC ${MANAGER_ID}`)
  line()

  let clients: { id: string; name: string; manager: boolean; currency: string }[] = []
  try {
    const rows = await gaql(
      version,
      token,
      MANAGER_ID,
      MANAGER_ID,
      `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager,
              customer_client.currency_code, customer_client.status
       FROM customer_client WHERE customer_client.status = 'ENABLED'`
    )
    clients = rows.map((r) => ({
      id: String(r.customerClient?.id ?? ''),
      name: String(r.customerClient?.descriptiveName ?? '(unnamed)'),
      manager: r.customerClient?.manager === true,
      currency: String(r.customerClient?.currencyCode ?? ''),
    }))
  } catch (e) {
    console.error(`  ✗ ${e instanceof Error ? e.message : e}`)
    return
  }

  const leaves = clients.filter((c) => !c.manager && c.id !== MANAGER_ID)
  console.log(`  ${clients.length} accounts (${leaves.length} ad accounts, the rest managers)\n`)

  const scan = leaves.slice(0, SCAN_CAP)
  if (leaves.length > SCAN_CAP) {
    console.log(`  Showing channel mix for the first ${SCAN_CAP} of ${leaves.length} — the rest were NOT checked.\n`)
  }

  for (const c of scan) {
    try {
      const rows = await gaql(
        version,
        token,
        c.id,
        MANAGER_ID,
        `SELECT campaign.advertising_channel_type, metrics.cost_micros
         FROM campaign WHERE ${DATE_WHERE}`
      )
      const byType = new Map<string, number>()
      for (const r of rows) {
        const t = String(r.campaign?.advertisingChannelType ?? '?')
        byType.set(t, (byType.get(t) ?? 0) + money(r.metrics?.costMicros))
      }
      const mix = [...byType]
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([t, v]) => `${t} ${fmt(v, 0)}`)
        .join('  ')
      const pmax = byType.has('PERFORMANCE_MAX') ? ' ← PMAX' : ''
      console.log(`  ${c.id.padEnd(12)} ${c.name.slice(0, 28).padEnd(30)} ${mix || '(no spend)'}${pmax}`)
    } catch (e) {
      console.log(`  ${c.id.padEnd(12)} ${c.name.slice(0, 28).padEnd(30)} ✗ ${e instanceof Error ? e.message.slice(0, 60) : ''}`)
    }
  }
  console.log(`\n  Run a PMAX account through this to answer question 3:`)
  console.log(`    npx tsx scripts/google-ads-diagnose.ts <account-id> ${MANAGER_ID}`)
}

// ── 4. Product-level data — the decisive query ───────────────────────────────

type ProductRow = { itemId: string; channel: string; title: string; feedLabel: string; m: Agg }

async function productData(version: string, token: string): Promise<{ rows: ProductRow[]; tier: number }> {
  const base = `metrics.impressions, metrics.clicks, metrics.cost_micros,
                metrics.conversions, metrics.conversions_value`

  // Tiered because I'm not certain every segment below exists in the version we
  // land on. Richest query first; fall back rather than fail the diagnostic.
  const tiers = [
    `SELECT campaign.advertising_channel_type, segments.product_item_id, segments.product_title,
            segments.product_feed_label, ${base}
     FROM shopping_performance_view WHERE ${DATE_WHERE}`,
    `SELECT campaign.advertising_channel_type, segments.product_item_id, ${base}
     FROM shopping_performance_view WHERE ${DATE_WHERE}`,
    `SELECT segments.product_item_id, ${base}
     FROM shopping_performance_view WHERE ${DATE_WHERE}`,
  ]

  for (let i = 0; i < tiers.length; i++) {
    try {
      const raw = await gaql(version, token, CUSTOMER_ID, MANAGER_ID, tiers[i])
      const rows: ProductRow[] = raw.map((r) => ({
        itemId: String(r.segments?.productItemId ?? ''),
        channel: String(r.campaign?.advertisingChannelType ?? '?'),
        title: String(r.segments?.productTitle ?? ''),
        feedLabel: String(r.segments?.productFeedLabel ?? ''),
        m: (() => {
          const a = emptyAgg()
          add(a, r.metrics ?? {})
          return a
        })(),
      }))
      return { rows, tier: i }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`  (tier ${i} failed: ${msg.slice(0, 160)})`)
    }
  }
  return { rows: [], tier: -1 }
}

// ── 5. Do the item IDs match our feed? ───────────────────────────────────────

const IN_CHUNK = 200 // cap .in() list size to stay under URL limits (as lib/optimizationBuckets.ts)

async function matchAgainstFeeds(itemIds: Set<string>) {
  line()
  console.log('ID MATCH AGAINST OUR OWN FEEDS')
  line()

  // Deliberately NOT DATABASE_URL: that is only used by scripts/migrate.ts and
  // had gone stale (password authentication failed). The Supabase service-role
  // client is what the app itself uses, so it is the credential that is actually
  // kept working.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('  (skipped — missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
    return
  }
  const db = createClient(url, key)

  const ids = [...itemIds]

  // Three id shapes seen in the wild, all reducible to a Shopify product id:
  //
  //   12345678901234                     this app, product mode  → shopify_id
  //   12345678901234_5678901234          this app, variant mode  → shopify_id + variant
  //   shopify_dk_12345678901234_567890   Shopify's own Google & YouTube channel app
  //
  // The third is the interesting one: Merchant Center is fed by Shopify's channel
  // app rather than by this app, so a naive join finds nothing — but the product
  // id is right there in the string, so an extraction layer recovers the join.
  const SHOPIFY_CHANNEL = /^shopify_([a-z]{2})_(\d+)_(\d+)$/
  const OWN_VARIANT = /^(\d+)_(\d+)$/

  type Parsed = { itemId: string; productId: string; variantId?: string; shape: string }
  const parsed: Parsed[] = []
  const unparsed: string[] = []
  for (const id of ids) {
    const ch = SHOPIFY_CHANNEL.exec(id)
    if (ch) {
      parsed.push({ itemId: id, productId: ch[2], variantId: ch[3], shape: `shopify_${ch[1]}_*` })
      continue
    }
    const ov = OWN_VARIANT.exec(id)
    if (ov) {
      parsed.push({ itemId: id, productId: ov[1], variantId: ov[2], shape: 'egen variant-mode' })
      continue
    }
    if (/^\d+$/.test(id)) {
      parsed.push({ itemId: id, productId: id, shape: 'egen product-mode' })
      continue
    }
    unparsed.push(id)
  }

  const byShape = new Map<string, number>()
  for (const p of parsed) byShape.set(p.shape, (byShape.get(p.shape) ?? 0) + 1)
  console.log('  Item ID formats from Google:')
  for (const [s, n] of byShape) console.log(`    ${s.padEnd(24)} ${n}`)
  if (unparsed.length) console.log(`    ${'unknown'.padEnd(24)} ${unparsed.length}  (${unparsed.slice(0, 3).join(', ')})`)
  console.log('')

  const plain = [...new Set(parsed.map((p) => p.productId))]

  const { data: feedRows, error: feedErr } = await db.from('feeds').select('id, name')
  if (feedErr) {
    console.error(`  ✗ Could not read feeds: ${feedErr.message}`)
    return
  }
  const feedName = new Map((feedRows ?? []).map((f: { id: string; name: string }) => [f.id, f.name]))
  if (!feedName.size) {
    console.log('  (no feeds in the database)')
    return
  }

  // ── product-mode: item_id == products.shopify_id ──
  const hitsByFeed = new Map<string, Set<string>>()
  for (let i = 0; i < plain.length; i += IN_CHUNK) {
    const chunk = plain.slice(i, i + IN_CHUNK)
    const { data, error } = await db
      .from('products')
      .select('feed_id, shopify_id')
      .in('shopify_id', chunk)
    if (error) {
      console.error(`  ✗ Product lookup failed: ${error.message}`)
      return
    }
    for (const r of (data ?? []) as { feed_id: string; shopify_id: string }[]) {
      if (!hitsByFeed.has(r.feed_id)) hitsByFeed.set(r.feed_id, new Set())
      hitsByFeed.get(r.feed_id)!.add(String(r.shopify_id))
    }
  }

  const pct = (n: number) => (plain.length ? ((n / plain.length) * 100).toFixed(1) : '0.0')
  console.log(`  ${ids.length} item IDs → ${plain.length} unique Shopify product IDs after parsing\n`)

  if (!hitsByFeed.size) {
    console.log('  ✗ NO match on products.shopify_id in any feed.')
    console.log('    Either the catalogue is not synced into a feed here,')
    console.log('    or the Merchant Center store is a different one than the connected shop.')
  } else {
    for (const [feedId, hits] of [...hitsByFeed].sort((a, b) => b[1].size - a[1].size)) {
      console.log(
        `  ✓ ${(feedName.get(feedId) ?? feedId).padEnd(28)} ` +
          `match ${hits.size}/${plain.length} product IDs (${pct(hits.size)}%)`
      )
    }
  }

  const matchedAll = new Set([...hitsByFeed.values()].flatMap((s) => [...s]))
  const unmatched = plain.filter((id) => !matchedAll.has(id))
  if (unmatched.length) {
    console.log(`\n  ${unmatched.length} product IDs with no match. Examples: ${unmatched.slice(0, 5).join(', ')}`)
  }
}

// ── 6. Conversion value, split by conversion action ──────────────────────────
// metrics.conversions_value only sums actions flagged primary_for_goal, so its
// MEANING varies per account: revenue in one, gross profit in another (a
// ProfitMetrics "PM Gross Profit" action set as primary), or lead/call actions
// with no monetary value at all. A cross-client bucket engine cannot treat that
// number as interchangeable.
//
// The fix is to segment by conversion action and let each project choose which
// one feeds ROAS and which feeds POAS. This checks whether that segmentation is
// available AT ITEM LEVEL — if it is, real POAS comes straight from the API for
// any client running ProfitMetrics, with no COGS modelling at all.
//
// NB: segments.conversion_action_* is only valid alongside all_conversions
// metrics, never metrics.conversions.
async function conversionActionSplit(version: string, token: string, cur: string) {
  line()
  console.log('CONVERSION VALUE PER ACTION')
  line()

  const agg = (rows: Row[], perItem: boolean) => {
    const byAction = new Map<string, { conv: number; value: number; items: Set<string> }>()
    for (const r of rows) {
      const name = String(r.segments?.conversionActionName ?? '(unnamed)')
      if (!byAction.has(name)) byAction.set(name, { conv: 0, value: 0, items: new Set() })
      const a = byAction.get(name)!
      a.conv += num(r.metrics?.allConversions)
      a.value += num(r.metrics?.allConversionsValue)
      const item = r.segments?.productItemId
      if (perItem && item) a.items.add(String(item))
    }
    return byAction
  }

  let rows: Row[] = []
  let perItem = true
  try {
    rows = await gaql(
      version,
      token,
      CUSTOMER_ID,
      MANAGER_ID,
      `SELECT segments.product_item_id, segments.conversion_action_name,
              metrics.all_conversions, metrics.all_conversions_value
       FROM shopping_performance_view WHERE ${DATE_WHERE}`
    )
    console.log('  ✓ Can segment conversion action PER ITEM — that is all we need')
    console.log('    to read true POAS straight from the API (e.g. a PM Gross Profit action).\n')
  } catch (e) {
    console.log(`  ⚠ Per item did not work (${e instanceof Error ? e.message.slice(0, 100) : e})`)
    console.log('    Falling back to account level.\n')
    perItem = false
    try {
      rows = await gaql(
        version,
        token,
        CUSTOMER_ID,
        MANAGER_ID,
        `SELECT segments.conversion_action_name, metrics.all_conversions,
                metrics.all_conversions_value
         FROM campaign WHERE ${DATE_WHERE}`
      )
    } catch (e2) {
      console.error(`  ✗ ${e2 instanceof Error ? e2.message : e2}`)
      return
    }
  }

  const byAction = agg(rows, perItem)
  if (!byAction.size) {
    console.log('  (no conversion data in this period)')
    return
  }

  const nameW = Math.min(44, Math.max(20, ...[...byAction.keys()].map((k) => k.length)))
  console.log(
    `  ${'action'.padEnd(nameW)} ${'conv.'.padStart(9)} ${'value'.padStart(13)}` +
      (perItem ? '  items' : '')
  )
  for (const [name, a] of [...byAction].sort((x, y) => y[1].value - x[1].value)) {
    console.log(
      `  ${name.slice(0, nameW).padEnd(nameW)} ${fmt(a.conv, 1).padStart(9)} ` +
        `${fmt(a.value).padStart(13)}` + (perItem ? `  ${a.items.size}` : '')
    )
  }
  console.log(`\n  (values in ${cur}. The total double-counts across actions —`)
  console.log('   the same order is reported by several actions. That is why ONE must be chosen.)')
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nGoogle Ads diagnostics — account ${CUSTOMER_ID} via MCC ${MANAGER_ID}`)
  console.log(`Period: ${DATE_START} → ${DATE_END} (${DAYS} days)\n`)
  line()
  console.log('ACCESS')
  line()

  const token = await accessToken()
  const version = await probeVersion(token)

  if (LIST_ACCOUNTS) {
    await listAccounts(version, token)
    return
  }

  const cur = await accountInfo(version, token)
  const byCampaignType = await campaignMix(version, token, cur)
  await conversionHealth(version, token, cur)

  line()
  console.log(`PRODUCT DATA (shopping_performance_view, ${DATE_START} → ${DATE_END})`)
  line()

  const { rows, tier } = await productData(version, token)
  if (tier === -1) {
    console.log('  ✗ None of the queries worked — see the errors above.')
  } else if (!rows.length) {
    console.log('  ⚠ The query worked but returned ZERO rows.')
    console.log('    Either there is no Shopping/PMax activity in the period,')
    console.log('    or the account is not linked to a Merchant Center.')
  } else {
    console.log(`  Rows: ${rows.length}   (query tier ${tier}: ${['full', 'without feed_label', 'item_id only'][tier]})`)

    // Per channel type — this is the PMax question, answered empirically.
    const byChan = new Map<string, Agg>()
    const itemsByChan = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!byChan.has(r.channel)) {
        byChan.set(r.channel, emptyAgg())
        itemsByChan.set(r.channel, new Set())
      }
      const a = byChan.get(r.channel)!
      a.cost += r.m.cost
      a.impr += r.m.impr
      a.clicks += r.m.clicks
      a.conv += r.m.conv
      a.value += r.m.value
      if (r.itemId) itemsByChan.get(r.channel)!.add(r.itemId)
    }
    console.log('\n  Product data per campaign type:')
    for (const [c, a] of [...byChan].sort((x, y) => y[1].cost - x[1].cost)) {
      const total = byCampaignType.get(c)?.cost
      const cover = total ? ` — covers ${((a.cost / total) * 100).toFixed(0)}% of the account's ${c} spend` : ''
      console.log(
        `    ${c.padEnd(24)} ${itemsByChan.get(c)!.size} items, spend ${fmt(a.cost)} ${cur}${cover}`
      )
    }

    // Roll up to item level, exactly as the bucket engine would.
    const byItem = new Map<string, Agg>()
    for (const r of rows) {
      if (!r.itemId) continue
      if (!byItem.has(r.itemId)) byItem.set(r.itemId, emptyAgg())
      const a = byItem.get(r.itemId)!
      a.cost += r.m.cost
      a.impr += r.m.impr
      a.clicks += r.m.clicks
      a.conv += r.m.conv
      a.value += r.m.value
    }

    const feedLabels = new Set(rows.map((r) => r.feedLabel).filter(Boolean))
    if (feedLabels.size) console.log(`\n  Feed labels: ${[...feedLabels].join(', ')}`)

    console.log(`\n  Unique item IDs: ${byItem.size}`)
    // Width is derived, never fixed: a hardcoded 34 silently truncated
    // shopify_dk_<productId>_<variantId> ids to look like duplicates.
    const idW = Math.max(12, ...[...byItem.keys()].map((k) => k.length))
    console.log('\n  Top 15 by spend (exactly what the bucket engine will consume):')
    console.log(
      `    ${'item_id'.padEnd(idW)} ${'spend'.padStart(10)} ${'conv.value'.padStart(12)} ` +
        `${'ROAS'.padStart(7)} ${'clicks'.padStart(6)} ${'impr.'.padStart(8)}`
    )
    const top = [...byItem].sort((a, b) => b[1].cost - a[1].cost).slice(0, 15)
    for (const [id, a] of top) {
      const roas = a.cost > 0 ? fmt(a.value / a.cost) : '—'
      console.log(
        `    ${id.padEnd(idW)} ${fmt(a.cost).padStart(10)} ${fmt(a.value).padStart(12)} ` +
          `${roas.padStart(7)} ${String(a.clicks).padStart(6)} ${String(a.impr).padStart(8)}`
      )
    }

    // The zero-division / no-data problem, quantified up front.
    const noCost = [...byItem.values()].filter((a) => a.cost === 0).length
    const noConv = [...byItem.values()].filter((a) => a.cost > 0 && a.conv === 0).length
    console.log(`\n  Items with 0 spend:            ${noCost}  (cannot have a ROAS — need their own bucket)`)
    console.log(`  Items with spend but 0 conv.:  ${noConv}  ("zombies")`)

    await matchAgainstFeeds(new Set(byItem.keys()))
  }

  await conversionActionSplit(version, token, cur)

  line()
  console.log('Done. No data was written anywhere.')
  line()
}

main().catch((e) => {
  console.error('\n✗ Diagnostics failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
