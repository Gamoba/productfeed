import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getFeedSettings } from '@/lib/feedGoogleAds'
import {
  formatInt,
  formatMoney,
  formatPercent,
  getProductPerformance,
  resolveActions,
  type Window,
} from '@/lib/googleAdsAnalytics'
import { getStockForFeed, stockAgeDays } from '@/lib/inventoryAnalytics'
import { WasteTables, type WasteRow } from './WasteTables'
import './waste.css'

const WINDOWS: Window[] = [7, 14, 30, 90, 180, 365]
const DEFAULT_WINDOW: Window = 30

// Feed › Wasted spend. Spend on products that give nothing back: no revenue at
// all, revenue below the ad cost, or out of stock right now. A list to look at,
// not a list to act on blindly — the Forslag card points to where to act.
export default async function WastedSpendPage({
  params,
  searchParams,
}: {
  params: Promise<{ feedId: string }>
  searchParams: Promise<{
    days?: string
    roas?: string | string[]
    poas?: string | string[]
  }>
}) {
  const { feedId } = await params
  const { days: daysParam, roas: roasParam, poas: poasParam } = await searchParams

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const parsed = Number(daysParam)
  const days: Window = WINDOWS.includes(parsed as Window) ? (parsed as Window) : DEFAULT_WINDOW

  const asArray = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v])
  const hrefFor = (w: Window) => {
    const p = new URLSearchParams()
    p.set('days', String(w))
    for (const v of asArray(roasParam)) p.append('roas', v)
    for (const v of asArray(poasParam)) p.append('poas', v)
    return `/feed/${feedId}/google-ads/waste?${p.toString()}`
  }

  const db = adminDb()
  const settings = await getFeedSettings(db, feedId)
  const currency = settings?.currency_code ?? 'DKK'

  if (!settings?.customer_id) {
    return (
      <Shell days={days} hrefFor={hrefFor}>
        <Empty
          title="This feed is not connected to Google Ads"
          body="The report reads the spend Google has attributed to your products, so the feed needs a connection and at least one sync first."
          action={{ href: `/feed/${feedId}/google-ads`, label: 'Go to Performance' }}
        />
      </Shell>
    )
  }

  const actions = resolveActions({ roas: roasParam, poas: poasParam }, settings)

  if (!actions.roas.length) {
    return (
      <Shell days={days} hrefFor={hrefFor}>
        <Empty
          title="No revenue conversion action is selected"
          body="Wasted spend is spend without revenue, so the report needs to know which action counts as revenue. Without it, every product looks as if it has sold nothing."
          action={{ href: `/feed/${feedId}/google-ads?days=${days}`, label: 'Choose it on Performance' }}
        />
      </Shell>
    )
  }

  const { rows, totals, from, to } = await getProductPerformance(db, feedId, days, actions)

  const matched = rows.filter((r) => !r.unmatched)
  const unmatchedCost = rows.filter((r) => r.unmatched).reduce((n, r) => n + r.cost, 0)

  const wasted = matched.filter((r) => r.cost > 0 && r.roas_conversions === 0).sort((a, b) => b.cost - a.cost)
  const wastedCost = wasted.reduce((n, r) => n + r.cost, 0)

  const losing = matched
    .filter((r) => r.roas_conversions > 0 && r.profitAfterAdSpend !== null && r.profitAfterAdSpend < 0)
    .sort((a, b) => (a.profitAfterAdSpend ?? 0) - (b.profitAfterAdSpend ?? 0))
  const losingCost = losing.reduce((n, r) => n + (r.profitAfterAdSpend ?? 0), 0)

  // ── Spend on products that cannot be shipped ──
  // FORWARD-LOOKING: stock is what it is NOW, the spend is the whole window. So
  // the claim is "this is spending on something that cannot be bought today",
  // never "this money was wasted".
  const stock = await getStockForFeed(db, feedId)
  const unavailable = matched
    .filter((r) => r.cost > 0)
    .map((r) => ({ row: r, stock: r.productRef ? stock.byProduct.get(r.productRef) : undefined }))
    // Only products whose stock is actually KNOWN and actually gone.
    .filter(({ stock: s }) => s !== undefined && s.outOfStock)
    .map(({ row }) => row)
    .sort((a, b) => b.cost - a.cost)
  const unavailableCost = unavailable.reduce((n, r) => n + r.cost, 0)

  const toRow = (r: (typeof rows)[number]): WasteRow => ({
    productRef: r.productRef,
    title: r.title,
    handle: r.handle,
    vendor: r.vendor,
    productType: r.productType,
    impressions: r.impressions,
    clicks: r.clicks,
    cost: r.cost,
    poasValue: r.poas_value,
    profitAfterAdSpend: r.profitAfterAdSpend,
    variantsTotal: r.productRef ? (stock.byProduct.get(r.productRef)?.variantsTotal ?? 0) : 0,
  })

  // Suggestions: where to act on what this page found. Links only — nothing
  // here changes the feed.
  const f = (p: string) => `/feed/${feedId}${p}`
  const suggestions: { text: string; href: string; cta: string }[] = []
  if (unavailable.length > 0)
    suggestions.push({
      text: `${formatInt(unavailable.length)} ${unavailable.length === 1 ? 'product is' : 'products are'} out of stock but still get budget. A rule for stock below 1 takes them out of the feed.`,
      href: f('/filters'),
      cta: 'Open Include / exclude',
    })
  if (wasted.length > 0)
    suggestions.push({
      text: `${formatInt(wasted.length)} ${wasted.length === 1 ? 'product has' : 'products have'} spent ${formatMoney(wastedCost, currency)} without revenue. Put them in a bucket with lower bids.`,
      href: f('/google-ads/labels'),
      cta: 'Open Labels',
    })
  if (losing.length > 0)
    suggestions.push({
      text: `${formatInt(losing.length)} ${losing.length === 1 ? 'product sells' : 'products sell'} at a loss after ad spend. Check margin and break-even before you cut back.`,
      href: f(`/google-ads?days=${days}`),
      cta: 'Open Performance',
    })

  return (
    <Shell days={days} hrefFor={hrefFor}>
      <p className="ws-def">
        Revenue = {actions.roas.map((a) => `«${a}»`).join(' + ')}
        {actions.poas.length > 0 && <> · Gross profit = {actions.poas.map((a) => `«${a}»`).join(' + ')}</>}
        {' · '}
        <Link href={`/feed/${feedId}/google-ads?days=${days}`} className="link">
          Change on Performance
        </Link>
      </p>

      <div className="ws-top">
        <section className="card ws-stats">
          <div>
            <span>Spend without revenue</span>
            <strong className={`num${wastedCost > 0 ? ' neg' : ''}`}>{formatMoney(wastedCost, currency)}</strong>
            <small>last {days} days</small>
          </div>
          <div>
            <span>Products</span>
            <strong className="num">{formatInt(wasted.length)}</strong>
            <small>with spend and no revenue</small>
          </div>
          <div>
            <span>Share of spend</span>
            <strong className="num">{totals.cost > 0 ? formatPercent(wastedCost / totals.cost) : '—'}</strong>
            <small>of {formatMoney(totals.cost, currency)} in total</small>
          </div>
        </section>

        <section className="card hi ws-hi">
          <span className="ws-hi-l">Suggestions</span>
          {suggestions.length === 0 ? (
            <p>Nothing to do right now. Every product with spend has generated revenue, and none is out of stock.</p>
          ) : (
            <ul>
              {suggestions.map((s) => (
                <li key={s.href}>
                  <p>{s.text}</p>
                  <Link href={s.href} className="ws-cta">
                    {s.cta}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <WasteTables
        days={days}
        currency={currency}
        wasted={wasted.map(toRow)}
        wastedCost={wastedCost}
        losing={losing.map(toRow)}
        losingCost={losingCost}
        showLosing={actions.poas.length > 0}
        unavailable={unavailable.map(toRow)}
        unavailableCost={unavailableCost}
        stockSyncedAt={stock.syncedAt}
        stockAgeDays={stockAgeDays(stock.syncedAt)}
        wastedEmpty={
          <Empty
            title="Every product with spend has generated revenue"
            body={`Nothing has spent budget without return in the last ${days} days. Choose a longer period to look further back.`}
          />
        }
      />

      <div className="ws-notes">
        <p>
          {from} → {to}. Only spend Google can attribute to a product is included. Performance Max spend on placements
          without a product is not counted, so the figures are lower than the account&apos;s total spend.
        </p>
        {actions.poas.length === 0 && (
          <p>
            No gross profit action is selected, so products selling at a loss cannot be found — only those that have
            generated no revenue at all.
          </p>
        )}
        {unmatchedCost > 0 && (
          <p className="neg">
            {formatMoney(unmatchedCost, currency)} could not be matched to a product in the feed and is not included in the figures.
          </p>
        )}
        <p>
          A product without conversions is not necessarily a mistake. It may be new, seasonal, or show up on
          searches that convert elsewhere.
        </p>
      </div>
    </Shell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Shell({
  days,
  hrefFor,
  children,
}: {
  days: Window
  hrefFor: (w: Window) => string
  children: React.ReactNode
}) {
  return (
    <div className="ws">
      <div className="ws-head">
        <div>
          <h1>Wasted spend</h1>
          <p className="ws-lede">
            Spend on products that give nothing back. A list to look at, not to act on blindly.
          </p>
        </div>
        <div className="ws-seg" role="group" aria-label="Period">
          {WINDOWS.map((w) => (
            <Link key={w} href={hrefFor(w)} aria-current={w === days ? 'true' : undefined}>
              {w}d
            </Link>
          ))}
        </div>
      </div>
      {children}
    </div>
  )
}

function Empty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: { href: string; label: string }
}) {
  return (
    <section className="card ws-empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {action && (
        <Link href={action.href} className="wl-btn-primary">
          {action.label}
        </Link>
      )}
    </section>
  )
}
