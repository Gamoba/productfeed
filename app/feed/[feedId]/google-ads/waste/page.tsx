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

const WINDOWS: Window[] = [7, 14, 30, 90, 180, 365]
const DEFAULT_WINDOW: Window = 30


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
      <Shell feedName={feed.name} days={days} hrefFor={hrefFor}>
        <Empty
          title="Not connected to Google Ads"
          body="This report reads spend that Google has already attributed to your products, so the feed needs a connection and at least one sync first."
          action={{ href: `/feed/${feedId}/google-ads`, label: 'Go to Performance →' }}
        />
      </Shell>
    )
  }

  const actions = resolveActions({ roas: roasParam, poas: poasParam }, settings)

  if (!actions.roas.length) {
    return (
      <Shell feedName={feed.name} days={days} hrefFor={hrefFor}>
        <Empty
          title="No revenue conversion action is selected"
          body="Waste is spend that produced no revenue, so this report needs to know which conversion action counts as revenue. Without one, every product looks like it converted nothing."
          action={{ href: `/feed/${feedId}/google-ads?days=${days}`, label: 'Choose one on Performance →' }}
        />
      </Shell>
    )
  }

  const { rows, totals, from, to } = await getProductPerformance(db, feedId, days, actions)

  const matched = rows.filter((r) => !r.unmatched)
  const unmatchedCost = rows.filter((r) => r.unmatched).reduce((n, r) => n + r.cost, 0)

  const wasted = matched
    .filter((r) => r.cost > 0 && r.roas_conversions === 0)
    .sort((a, b) => b.cost - a.cost)

  const wastedCost = wasted.reduce((n, r) => n + r.cost, 0)

  const losing = matched
    .filter((r) => r.roas_conversions > 0 && r.profitAfterAdSpend !== null && r.profitAfterAdSpend < 0)
    .sort((a, b) => (a.profitAfterAdSpend ?? 0) - (b.profitAfterAdSpend ?? 0))

  const losingCost = losing.reduce((n, r) => n + (r.profitAfterAdSpend ?? 0), 0)

  // ── Spend on products that cannot be shipped ────────────────────────────
  //
  // FORWARD-LOOKING, AND THE WORDING HAS TO SAY SO. Stock is what it is NOW,
  // while the spend is the whole window — so a product that sold out yesterday
  // shows its full 30 days of spend here even though most of it bought
  // perfectly shippable clicks. The claim is therefore "this is spending on
  // something that cannot be bought today", never "this money was wasted".
  // Answering the retrospective question needs stock as it was on each day,
  // which is what variant_stock_snapshots is quietly collecting for later.
  const stock = await getStockForFeed(db, feedId)

  const unavailable = matched
    .filter((r) => r.cost > 0)
    .map((r) => ({ row: r, stock: r.productRef ? stock.byProduct.get(r.productRef) : undefined }))
    // Only products whose stock is actually KNOWN and actually gone. An
    // untracked product has no coverage to fail this test, which is the point.
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

  return (
    <Shell feedName={feed.name} days={days} hrefFor={hrefFor}>
      {/* ── What the numbers mean ─────────────────────────────────── */}
      <div className="wl-card" style={{ padding: '14px 18px' }}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <p style={{ fontSize: '12px', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
            Revenue = {actions.roas.map((a) => `«${a}»`).join(' + ')}
            {actions.poas.length > 0 && (
              <> · Gross profit = {actions.poas.map((a) => `«${a}»`).join(' + ')}</>
            )}
          </p>
          <Link
            href={`/feed/${feedId}/google-ads?days=${days}`}
            style={{ fontSize: '12px', color: 'var(--accent-purple)' }}
          >
            Change →
          </Link>
        </div>
      </div>

      {/* ── Headline ──────────────────────────────────────────────── */}
      <section className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
        <Stat
          label="Spend with no revenue"
          value={formatMoney(wastedCost, currency)}
          tone={wastedCost > 0 ? 'bad' : undefined}
        />
        <Stat label="Products" value={formatInt(wasted.length)} />
        <Stat
          label="Share of all spend"
          value={totals.cost > 0 ? formatPercent(wastedCost / totals.cost) : '—'}
        />
        <Stat label="Total spend" value={formatMoney(totals.cost, currency)} />
      </section>

      {/* ── The two lists, and the search over them ─────────── */}
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
            title="Every product with spend produced revenue"
            body={`Nothing in the last ${days} days took budget without returning anything. Widen the window if you want to look further back.`}
          />
        }
      />

      {/* ── Footnotes that stop the numbers being misread ─────────── */}
      <div className="space-y-1.5" style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
        <p>
          {from} — {to}. Only cost Google can attribute to a product is included.
          Performance Max spend on non-shopping placements is not counted, so these
          figures are lower than the account&apos;s total cost.
        </p>
        {actions.poas.length === 0 && (
          <p>
            No gross profit action is selected, so products that convert at a loss cannot
            be identified — only ones that produced no revenue at all.
          </p>
        )}
        {unmatchedCost > 0 && (
          <p style={{ color: 'var(--accent-amber)' }}>
            {formatMoney(unmatchedCost, currency)} could not be matched to a product in this
            feed and is excluded from the figures above.
          </p>
        )}
        <p>
          A product with no conversions is not automatically a mistake — it may be new, or
          seasonal, or serving a query that converts elsewhere. This is a list to look at,
          not a list to act on blindly.
        </p>
      </div>
    </Shell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Shell({
  feedName,
  days,
  hrefFor,
  children,
}: {
  feedName: string
  days: Window
  hrefFor: (w: Window) => string
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <main className="max-w-6xl mx-auto px-6 py-9 space-y-6">
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div className="space-y-1.5">
            <div className="wl-eyebrow truncate">{feedName}</div>
            <h1
              style={{
                fontSize: '34px',
                fontWeight: 500,
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
              }}
            >
              Wasted spend
            </h1>
          </div>
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <Link
                key={w}
                href={hrefFor(w)}
                className="wl-pill"
                style={{
                  background: w === days ? 'var(--accent-purple)' : 'transparent',
                  color: w === days ? '#fff' : 'var(--ink-muted)',
                  border: w === days ? 'none' : '1px solid var(--hairline)',
                }}
              >
                {w}d
              </Link>
            ))}
          </div>
        </header>
        {children}
      </main>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'bad'
}) {
  return (
    <div className="wl-card" style={{ padding: '16px 18px' }}>
      <div className="wl-eyebrow">{label}</div>
      <div
        style={{
          fontSize: '26px',
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginTop: '6px',
          color: tone === 'bad' ? 'var(--accent-red)' : 'var(--ink)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
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
    <div className="wl-card" style={{ padding: '40px' }}>
      <div className="max-w-xl space-y-3">
        <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--ink)' }}>{title}</h2>
        <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink-secondary)' }}>{body}</p>
        {action && (
          <Link href={action.href} className="wl-btn-primary inline-block">
            {action.label}
          </Link>
        )}
      </div>
    </div>
  )
}
