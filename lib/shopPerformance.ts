// Shop › General performance: the shop's Google Ads numbers across its feeds.
//
// Each feed has its own Google Ads link and its own revenue/profit actions
// (feed Settings), so every feed is read with ITS settings and the results are
// added up. Two guards keep the sum honest:
//
//   - Same account twice. Two feeds pointing at the same Google Ads account
//     with the same feed label fetch the same rows. Only the first counts; the
//     others are listed but marked, or the shop's spend would double.
//   - Mixed currencies. Kroner and euros don't add up. The totals use the
//     currency most of the counted feeds report in; feeds in another currency
//     are shown in the table with their own numbers but left out of the sum.
//
// Read-only: everything comes from the synced tables, nothing calls Google.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import { channelOf, type ChannelId } from '@/lib/channels'
import { getDailyTotals, previousRange, windowRange, type DailyPoint } from '@/lib/googleAdsAnalytics'

export type ShopFeedPerf = {
  feedId: string
  name: string
  channel: ChannelId
  country: string | null
  items: number | null
  account: string | null
  currency: string | null
  /** Numbers for this feed's own window, or null when it has no account. */
  cost: number | null
  revenue: number | null
  profit: number | null
  /** Why this feed is not in the totals, when it isn't. */
  excluded: 'duplicate' | 'currency' | null
  duplicateOf: string | null
  profitTracked: boolean
}

export type Sums = { cost: number; revenue: number; profit: number }

export type ShopPerformance = {
  days: number
  from: string
  to: string
  currency: string | null
  current: Sums
  previous: Sums
  /** Whether at least one counted feed has a gross-profit action. */
  profitTracked: boolean
  daily: { date: string; cost: number | null; revenue: number | null; profit: number | null }[]
  feeds: ShopFeedPerf[]
  counted: number
}

const sum = (pts: DailyPoint[]): Sums =>
  pts.reduce(
    (s, p) => ({ cost: s.cost + p.cost, revenue: s.revenue + p.roas_value, profit: s.profit + p.poas_value }),
    { cost: 0, revenue: 0, profit: 0 }
  )

export async function getShopPerformance(db: SupabaseClient, projectId: string, days: number): Promise<ShopPerformance> {
  const { data: feedRows, error } = await db
    .from('feeds')
    .select('id, name, channel')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
  if (error) dbError('getShopPerformance feeds', error)
  const feeds = (feedRows ?? []) as { id: string; name: string; channel: string }[]
  const ids = feeds.map((f) => f.id)

  const [{ data: settings, error: sErr }, { data: markets, error: mErr }, { data: caches, error: cErr }] = ids.length
    ? await Promise.all([
        db
          .from('google_ads_feed_settings')
          .select('feed_id, customer_id, customer_name, currency_code, feed_label, roas_conversion_actions, poas_conversion_actions')
          .in('feed_id', ids),
        db.from('shop_settings').select('feed_id, selected_country').in('feed_id', ids),
        db.from('feed_cache').select('feed_id, product_count').in('feed_id', ids),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ]
  if (sErr) dbError('getShopPerformance settings', sErr)
  if (mErr) dbError('getShopPerformance markets', mErr)
  if (cErr) dbError('getShopPerformance cache', cErr)

  type S = {
    feed_id: string
    customer_id: string | null
    customer_name: string | null
    currency_code: string | null
    feed_label: string | null
    roas_conversion_actions: string[] | null
    poas_conversion_actions: string[] | null
  }
  const settingBy = new Map(((settings ?? []) as S[]).map((s) => [s.feed_id, s]))
  const countryBy = new Map(((markets ?? []) as { feed_id: string; selected_country: string | null }[]).map((m) => [m.feed_id, m.selected_country]))
  const itemsBy = new Map(((caches ?? []) as { feed_id: string; product_count: number | null }[]).map((c) => [c.feed_id, c.product_count]))

  const cur = windowRange(days)
  const prev = previousRange(days)

  // Pull each connected feed's daily totals, current and previous window.
  const pulled = await Promise.all(
    feeds.map(async (f) => {
      const s = settingBy.get(f.id)
      if (!s?.customer_id) return { f, s, now: null, before: null }
      const actions = { roas: s.roas_conversion_actions ?? [], poas: s.poas_conversion_actions ?? [] }
      const [now, before] = await Promise.all([
        getDailyTotals(db, f.id, days, actions, cur),
        getDailyTotals(db, f.id, days, actions, prev),
      ])
      return { f, s, now, before }
    })
  )

  // Currency of the totals: the one most connected feeds report in.
  const tally = new Map<string, number>()
  for (const p of pulled) if (p.s?.customer_id) tally.set(p.s.currency_code ?? '', (tally.get(p.s.currency_code ?? '') ?? 0) + 1)
  const currency = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null

  const seen = new Map<string, string>()
  const current: Sums = { cost: 0, revenue: 0, profit: 0 }
  const previous: Sums = { cost: 0, revenue: 0, profit: 0 }
  const byDay = new Map<string, Sums>()
  let profitTracked = false
  let counted = 0

  const out: ShopFeedPerf[] = pulled.map(({ f, s, now, before }) => {
    const base = {
      feedId: f.id,
      name: f.name,
      channel: channelOf(f.channel).id,
      country: countryBy.get(f.id) ?? null,
      items: itemsBy.get(f.id) ?? null,
      account: s?.customer_id ? (s.customer_name ?? s.customer_id) : null,
      currency: s?.currency_code ?? null,
      profitTracked: (s?.poas_conversion_actions ?? []).length > 0,
    }
    if (!s?.customer_id || !now || !before) {
      return { ...base, cost: null, revenue: null, profit: null, excluded: null, duplicateOf: null }
    }
    const mine = sum(now)
    const key = `${s.customer_id}|${(s.feed_label ?? '').trim().toLowerCase()}`
    const dup = seen.get(key)
    let excluded: ShopFeedPerf['excluded'] = null
    if (dup) excluded = 'duplicate'
    else if ((s.currency_code || null) !== currency) excluded = 'currency'
    else {
      seen.set(key, f.name)
      counted++
      const old = sum(before)
      current.cost += mine.cost
      current.revenue += mine.revenue
      current.profit += mine.profit
      previous.cost += old.cost
      previous.revenue += old.revenue
      previous.profit += old.profit
      if (base.profitTracked) profitTracked = true
      for (const p of now) {
        const d = byDay.get(p.date) ?? { cost: 0, revenue: 0, profit: 0 }
        d.cost += p.cost
        d.revenue += p.roas_value
        d.profit += p.poas_value
        byDay.set(p.date, d)
      }
    }
    return { ...base, cost: mine.cost, revenue: mine.revenue, profit: base.profitTracked ? mine.profit : null, excluded, duplicateOf: dup ?? null }
  })

  // A continuous axis over the window; a day no counted feed reported stays null.
  const daily: ShopPerformance['daily'] = []
  for (let t = Date.parse(`${cur.from}T00:00:00Z`); t <= Date.parse(`${cur.to}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10)
    const d = byDay.get(date)
    daily.push({ date, cost: d?.cost ?? null, revenue: d?.revenue ?? null, profit: d?.profit ?? null })
  }

  return { days, from: cur.from, to: cur.to, currency, current, previous, profitTracked, daily, feeds: out, counted }
}
