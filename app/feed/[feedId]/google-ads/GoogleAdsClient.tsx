'use client'

import { useRouter } from 'next/navigation'
import { Fragment, useMemo, useState } from 'react'
import {
  breakEvenRoas,
  delta,
  formatInt,
  formatMoney,
  formatPercent,
  formatRatio,
  vatUplift,
  type ActionChoice,
  type AvailableAction,
  type Delta,
  type ProductRow,
  type Totals,
  type VariantRow,
  type Window,
} from '@/lib/googleAdsAnalytics'
import { STALE_STOCK_DAYS } from '@/lib/inventoryAnalytics'
import { GoogleAdsSetup } from './GoogleAdsSetup'

/**
 * Days of stock below which the note is worth drawing attention to.
 *
 * Roughly a Google Ads learning cycle: below this, anything you change today
 * stops mattering before it has finished taking effect.
 */
const LOW_STOCK_DAYS = 14

type SettingsView = {
  customerName: string | null
  customerId: string | null
  currency: string | null
  roasActions: string[]
  poasActions: string[]
  lastSyncedAt: string | null
  lastSyncError: string | null
  feedLabel: string | null
}

type Props = {
  feedId: string
  feedName: string
  days: Window
  windows: Window[]
  connected: boolean
  hasConnection: boolean
  setupIssues: string[]
  connectError: string | null
  justConnected: boolean
  settings: SettingsView | null
  availableActions: AvailableAction[]
  activeActions: ActionChoice
  rows: ProductRow[]
  trend: TrendPoint[]
  comparison: ComparisonView | null
  margins: Record<string, { margin: number | null; asEntered: number | null; coverage: number }>
  marginCoverage: { withMargin: number; products: number }
  returns: Record<
    string,
    { returnRate: number | null; refundedInWindow: number; sampleUnits: number }
  >
  returnsContext: ReturnsContext | null
  stock: Record<string, StockView>
  stockContext: StockContext | null
  vat: {
    pricesIncludeVat: boolean | null
    conversionValueIncludesVat: boolean | null
    rate: number | null
  }
  totals: Totals | null
  from: string
  to: string
}

export type TrendPoint = {
  date: string
  cost: number
  revenue: number
  profit: number
  clicks: number
  roas: number | null
}

/**
 * The previous period, reduced to the figures this page compares against.
 *
 * `partial` is the load-bearing field: when the earlier window predates the
 * archive it is only fractionally covered, every delta reads as growth, and the
 * page has to say so instead of drawing a green arrow. See getComparison.
 */
export type ComparisonView = {
  from: string
  to: string
  partial: boolean
  coveredDays: number
  totals: {
    cost: number
    clicks: number
    impressions: number
    roasValue: number
    poasValue: number
    roas: number | null
    poas: number | null
  }
  byProduct: Record<
    string,
    { cost: number; roasValue: number; roas: number | null; poas: number | null }
  >
}

/**
 * One product's stock, as of the last catalogue sync.
 *
 * Every field is nullable for its own reason (lib/inventoryAnalytics.ts), and
 * the cell below renders each null as silence rather than as a number — an
 * untracked product is not an empty one.
 */
type StockView = {
  quantity: number | null
  coverage: number | null
  daysOfStock: number | null
  outOfStock: boolean
  variantsTotal: number
  variantsSellable: number
}

/** One variant's stock, as the drill-down receives it. */
type VariantStockView = {
  title: string | null
  sku: string | null
  sellable: boolean
  quantity: number | null
  daysOfStock: number | null
}

type StockContext = {
  syncedAt: string | null
  /** How old the stock figures are. Product sync is manual, so this can be large. */
  ageDays: number | null
  velocityFrom: string
  velocityTo: string
  velocityDays: number
  /** Null when the shop's locations have never been detected. */
  locationCount: number | null
  /** More than one place holding stock, so the quantity is not market-specific. */
  multipleLocations: boolean
}

type ReturnsContext = {
  country: string | null
  cohortFrom: string
  cohortTo: string
  overallRate: number | null
  overallSample: number
  refundedInWindow: number
  returnedInWindow: number
  otherRefundedInWindow: number
  archiveDepthDays: number | null
  archiveLastRunAt: string | null
  archiveHasGap: boolean
}

type Row = ProductRow & {
  margin: number | null
  marginCoverage: number
  /**
   * The ROAS at which gross profit exactly covers ad cost.
   *
   * Null covers two different things, and the cell tells them apart by looking
   * at `netMargin`: no cost entered (unknown), or a margin of zero or less,
   * where no revenue multiple ever repays the spend.
   */
  breakEvenRoas: number | null
  /**
   * The margin break-even was actually derived from — always the authoritative
   * net one, even while the column beside it is displaying the gross basis.
   * Carried separately so the cell can tell "no cost" from "no margin" without
   * having to know which basis `margin` is currently on.
   */
  netMargin: number | null
  returnRate: number | null
  returnSample: number
  refundedInWindow: number
  netRoas: number | null
  netPoas: number | null
  /** Undefined when the product could not be matched to the catalogue at all. */
  stock: StockView | undefined
  /** Change vs the previous period. Null when the product had no data then. */
  dCost: Delta | null
  dRevenue: Delta | null
  dRoas: Delta | null
  /**
   * Sort keys for the change columns. A product absent from the previous period
   * sorts LAST via compare()'s null handling rather than as a huge gain — it
   * did not grow, it appeared, and those are different findings.
   */
  dCostPct: number | null
  dRevenuePct: number | null
  dRoasAbs: number | null
}

type SortKey =
  | 'cost'
  | 'roas'
  | 'poas'
  | 'clicks'
  | 'impressions'
  | 'roas_value'
  | 'poas_value'
  | 'margin'
  | 'breakEvenRoas'
  | 'netRoas'
  | 'netPoas'
  | 'refundedInWindow'
  | 'returnRate'
  | 'dCostPct'
  | 'dRevenuePct'
  | 'dRoasAbs'

const describeActions = (list: string[]): string =>
  list.length === 0 ? 'not selected' : list.map((a) => `«${a}»`).join(' + ')

function compare(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * dir
}

export function GoogleAdsClient({
  feedId,
  feedName,
  days,
  windows,
  connected,
  hasConnection,
  setupIssues,
  connectError,
  justConnected,
  settings,
  availableActions,
  activeActions,
  rows,
  trend,
  comparison,
  margins,
  marginCoverage,
  returns,
  returnsContext,
  stock,
  stockContext,
  vat,
  totals,
  from,
  to,
}: Props) {
  const router = useRouter()
  const [showSetup, setShowSetup] = useState(!connected)
  const [sortKey, setSortKey] = useState<SortKey>('cost')
  const [sortDir, setSortDir] = useState<1 | -1>(-1)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [variants, setVariants] = useState<Record<string, VariantRow[]>>({})
  const [variantReturns, setVariantReturns] = useState<
    Record<string, { returnRate: number | null; refundedInWindow: number; sampleUnits: number }>
  >({})
  // Nested by product, then by variant_ref, covering EVERY variant of the
  // expanded product including ones with no ad data — see the route.
  //
  // NESTED, unlike variantReturns above, and the difference is load-bearing:
  // this map is ENUMERATED to find unavailable variants missing from the ads
  // rows. A flat map accumulates across every product opened this session, so
  // enumerating it would list one product's out-of-stock variants underneath
  // another. Returns are only ever looked up by key, so they can stay flat.
  const [variantStock, setVariantStock] = useState<
    Record<string, Record<string, VariantStockView>>
  >({})
  const [loadingVariants, setLoadingVariants] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncNote, setSyncNote] = useState<string | null>(null)
  const [savingDefaults, setSavingDefaults] = useState(false)

  const currency = settings?.currency ?? 'DKK'

  const urlWith = (patch: { days?: Window; roas?: string[]; poas?: string[] }) => {
    const q = new URLSearchParams()
    q.set('days', String(patch.days ?? days))
    for (const key of ['roas', 'poas'] as const) {
      const list = patch[key] ?? activeActions[key]
      if (list.length) for (const a of list) q.append(key, a)
      else q.set(key, '')
    }
    return `/feed/${feedId}/google-ads?${q.toString()}`
  }

  const [grossBasis, setGrossBasis] = useState(false)
  const vatApplies = vat.pricesIncludeVat === true && !!vat.rate && vat.rate > 0

  // How much the reported conversion value overstates net revenue. Null means
  // nobody has said — break-even then assumes the value is net, which is the
  // OPTIMISTIC end of the range, so the footnote flags it in amber rather than
  // letting the column pass as verified.
  const uplift = vatUplift(vat.conversionValueIncludesVat, vat.rate)

  const [showReturns, setShowReturns] = useState(false)
  const [showCompare, setShowCompare] = useState(false)

  // Product sync is manual, so a stock figure can be arbitrarily old while
  // looking exactly as current as everything else on the page. Past the
  // threshold the notes are drawn in amber rather than hidden — directionally
  // useful and openly stale beats absent.
  const stockStale =
    stockContext?.ageDays !== null &&
    stockContext?.ageDays !== undefined &&
    stockContext.ageDays > STALE_STOCK_DAYS

  const sorted = useMemo(() => {
    const merged: Row[] = rows.map((r) => {
      const m = r.productRef ? margins[r.productRef] : undefined
      const value = grossBasis ? (m?.asEntered ?? null) : (m?.margin ?? null)

      const ret = r.productRef ? returns[r.productRef] : undefined
      const rate = ret?.returnRate ?? null
      const kept = rate === null ? null : 1 - rate

      // Absent from the previous period is NOT zero: a product that first
      // served this month has no baseline, and delta() returning null keeps it
      // out of every change column instead of crediting it with infinite growth.
      const prev = r.productRef ? comparison?.byProduct[r.productRef] : undefined
      const dCost = delta(r.cost, prev?.cost ?? null)
      const dRevenue = delta(r.roas_value, prev?.roasValue ?? null)
      const dRoas = delta(r.roas, prev?.roas ?? null)

      return {
        dCost,
        dRevenue,
        dRoas,
        dCostPct: dCost?.pct ?? null,
        dRevenuePct: dRevenue?.pct ?? null,
        dRoasAbs: dRoas?.abs ?? null,
        ...r,
        margin: value,
        // NOT `value`: break-even is compared against a real ROAS, so it has to
        // mean one thing regardless of which basis someone is viewing the
        // Margin column on — the same rule the custom-label engine follows for
        // cogs_margin. Flipping to the gross basis moves the Margin column and
        // deliberately leaves this one still.
        netMargin: m?.margin ?? null,
        breakEvenRoas: breakEvenRoas(m?.margin ?? null, uplift ?? 1),
        marginCoverage: m?.coverage ?? 0,
        returnRate: rate,
        returnSample: ret?.sampleUnits ?? 0,
        refundedInWindow: ret?.refundedInWindow ?? 0,
        netRoas: kept === null || r.roas === null ? null : r.roas * kept,
        netPoas: kept === null || r.poas === null ? null : r.poas * kept,
        stock: r.productRef ? stock[r.productRef] : undefined,
      }
    })
    merged.sort((a, b) => compare(a[sortKey], b[sortKey], sortDir))
    return merged
  }, [rows, margins, returns, stock, comparison, sortKey, sortDir, grossBasis, uplift])

  const visible = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return sorted
    return sorted.filter((r) => {
      const hay = [r.title, r.productRef, r.handle, r.vendor, r.productType]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [sorted, query])

  const unmatchedCost = useMemo(
    () => rows.filter((r) => r.unmatched).reduce((n, r) => n + r.cost, 0),
    [rows]
  )

  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x))

  const defaultsDiffer =
    !!settings &&
    (!sameSet(activeActions.roas, settings.roasActions) ||
      !sameSet(activeActions.poas, settings.poasActions))

  function setSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1))
    else {
      setSortKey(key)
      setSortDir(-1)
    }
  }

  async function toggle(productRef: string | null) {
    if (!productRef) return
    if (expanded === productRef) {
      setExpanded(null)
      return
    }
    setExpanded(productRef)
    if (variants[productRef]) return

    setLoadingVariants(productRef)
    try {
      const q = new URLSearchParams({ product: productRef, days: String(days) })
      for (const a of activeActions.roas) q.append('roas', a)
      for (const a of activeActions.poas) q.append('poas', a)
      const res = await fetch(`/api/google-ads/${feedId}/variants?${q.toString()}`)
      const json = await res.json()
      if (res.ok) {
        setVariants((v) => ({ ...v, [productRef]: json.variants ?? [] }))
        setVariantReturns((v) => ({ ...v, ...(json.returns ?? {}) }))
        setVariantStock((v) => ({ ...v, [productRef]: json.stock ?? {} }))
      }
    } finally {
      setLoadingVariants(null)
    }
  }

  async function saveDefaults() {
    if (!settings?.customerId) return
    setSavingDefaults(true)
    try {
      await fetch(`/api/google-ads/${feedId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: settings.customerId,
          customerName: settings.customerName,
          currencyCode: settings.currency,
          feedLabel: settings.feedLabel,
          roasConversionActions: activeActions.roas,
          poasConversionActions: activeActions.poas,
          syncNow: false,
        }),
      })
      router.refresh()
    } finally {
      setSavingDefaults(false)
    }
  }

  async function refresh() {
    setSyncing(true)
    setSyncError(null)
    setSyncNote(null)
    try {
      const res = await fetch(`/api/google-ads/${feedId}/sync`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        setSyncError(json.error ?? 'Sync failed')
        return
      }
      const warnings: string[] = json.result?.warnings ?? []
      if (warnings.length) setSyncNote(warnings.join(' '))
      setVariants({})
      // Stock is re-read by the same request, so a stale copy would otherwise
      // outlive the numbers it was fetched alongside.
      setVariantStock({})
      router.refresh()
    } catch {
      setSyncError('Could not reach the server')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      {/* The product table is wide (11 numeric columns + variants), so the old
          max-w-6xl (1152px) cap squeezed it while the AppShell content area —
          flex-1, no cap — sat half empty. Inline maxWidth so it can't be silently
          dropped by class generation; still centred so ultrawide doesn't sprawl. */}
      <main className="mx-auto px-6 py-9 space-y-7" style={{ maxWidth: '1800px' }}>
        {/* ── Header ─────────────────────────────────────────────── */}
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
              Product performance
            </h1>
            {connected && settings && (
              <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
                {settings.customerName ?? settings.customerId}
                {settings.feedLabel ? ` · ${settings.feedLabel}` : ''}
                {from && ` · ${from} → ${to}`}
              </p>
            )}
          </div>

          {connected && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1">
                {windows.map((w) => (
                  <button
                    key={w}
                    onClick={() => router.push(urlWith({ days: w }))}
                    className="wl-pill"
                    style={{
                      cursor: 'pointer',
                      background: w === days ? 'var(--accent-purple)' : 'transparent',
                      color: w === days ? '#fff' : 'var(--ink-muted)',
                      border: w === days ? 'none' : '1px solid var(--hairline)',
                    }}
                  >
                    {w}d
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowSetup((s) => !s)}
                className="wl-btn-secondary shrink-0"
              >
                Settings
              </button>
              <button onClick={refresh} disabled={syncing} className="wl-btn-primary shrink-0">
                {syncing ? 'Fetching…' : 'Refresh data'}
              </button>
            </div>
          )}
        </header>

        {/* Outcome of the OAuth redirect, which lands back here with a query flag. */}
        {connectError && (
          <div className="wl-card" style={{ padding: '16px' }}>
            <div className="flex items-start gap-2.5">
              <span className="wl-dot shrink-0" style={{ background: 'var(--accent-red)', marginTop: '5px' }} />
              <p style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>{connectError}</p>
            </div>
          </div>
        )}
        {justConnected && !connected && (
          <div className="wl-card" style={{ padding: '16px' }}>
            <div className="flex items-start gap-2.5">
              <span className="wl-dot shrink-0" style={{ background: 'var(--accent-green)', marginTop: '5px' }} />
              <p style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>
                Google Ads is authorised. Now choose the account.
              </p>
            </div>
          </div>
        )}

        {/* ── Setup ──────────────────────────────────────────────── */}
        {showSetup && (
          <GoogleAdsSetup
            feedId={feedId}
            hasConnection={hasConnection}
            current={{
              customerId: settings?.customerId ?? null,
              roasActions: settings?.roasActions ?? [],
              poasActions: settings?.poasActions ?? [],
              feedLabel: settings?.feedLabel ?? null,
            }}
            onDone={() => setShowSetup(false)}
          />
        )}

        {/* ── Setup warnings on a connected feed ─────────────────── */}
        {connected && setupIssues.length > 0 && (
          <div className="wl-card" style={{ padding: '16px' }}>
            <div className="flex items-start gap-2.5">
              <span
                className="wl-dot shrink-0"
                style={{ background: 'var(--accent-amber)', marginTop: '5px' }}
              />
              <div>
                <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>
                  Setup is incomplete
                </p>
                {setupIssues.map((i) => (
                  <p key={i} style={{ fontSize: '12px', color: 'var(--ink-secondary)' }}>
                    {i}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}

        {(syncError || settings?.lastSyncError) && (
          <div className="wl-card" style={{ padding: '16px' }}>
            <div className="flex items-start gap-2.5">
              <span
                className="wl-dot shrink-0"
                style={{ background: 'var(--accent-red)', marginTop: '5px' }}
              />
              <p style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>
                {syncError ?? settings?.lastSyncError}
              </p>
            </div>
          </div>
        )}

        {syncNote && (
          <div className="wl-card" style={{ padding: '16px' }}>
            <p style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>{syncNote}</p>
          </div>
        )}

        {connected && availableActions.length > 0 && (
          <section className="wl-card" style={{ padding: '16px 18px' }}>
            <div className="flex flex-wrap items-end gap-4">
              <MetricPicker
                label="Revenue (ROAS)"
                selected={activeActions.roas}
                actions={availableActions}
                currency={currency}
                onChange={(v) => router.push(urlWith({ roas: v }))}
              />
              <MetricPicker
                label="Gross profit (POAS)"
                selected={activeActions.poas}
                actions={availableActions}
                currency={currency}
                onChange={(v) => router.push(urlWith({ poas: v }))}
              />
              {settings && defaultsDiffer && (
                <button
                  onClick={saveDefaults}
                  disabled={savingDefaults}
                  className="wl-btn-secondary"
                >
                  {savingDefaults ? 'Saving…' : 'Save as default'}
                </button>
              )}
            </div>
            <p
              style={{
                fontSize: '12px',
                color: 'var(--ink-muted)',
                marginTop: '10px',
                lineHeight: 1.5,
                maxWidth: '62ch',
              }}
            >
              The same order is usually counted by several actions at once. The amount next
              to each action is what it reports over the period
            </p>
          </section>
        )}

        {connected && totals && (
          <section className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
            {/* Cost rising is not good news, so its arrow is inverted. Everything
                else on this row is a figure you want larger. */}
            <Stat
              label="Cost"
              value={formatMoney(totals.cost, currency)}
              change={delta(totals.cost, comparison?.totals.cost ?? null)}
              invertChange
              suppressChange={comparison?.partial}
            />
            <Stat
              label="Revenue"
              value={formatMoney(totals.roas_value, currency)}
              change={delta(totals.roas_value, comparison?.totals.roasValue ?? null)}
              suppressChange={comparison?.partial}
            />
            <Stat
              label="ROAS"
              value={formatRatio(totals.roas)}
              tone={totals.roas === null ? undefined : totals.roas >= 1 ? 'good' : 'bad'}
              change={delta(totals.roas, comparison?.totals.roas ?? null)}
              suppressChange={comparison?.partial}
            />
            <Stat
              label="Gross profit"
              value={formatMoney(totals.poas_value, currency)}
              change={delta(totals.poas_value, comparison?.totals.poasValue ?? null)}
              suppressChange={comparison?.partial}
            />
            <Stat
              label="POAS"
              value={formatRatio(totals.poas)}
              tone={totals.poas === null ? undefined : totals.poas >= 1 ? 'good' : 'bad'}
              hint={
                totals.poas !== null && totals.poas < 1
                  ? 'Below 1 = ads cost more than the gross profit they return'
                  : undefined
              }
              change={delta(totals.poas, comparison?.totals.poas ?? null)}
              suppressChange={comparison?.partial}
            />
            <Stat
              label="Clicks"
              value={formatInt(totals.clicks)}
              change={delta(totals.clicks, comparison?.totals.clicks ?? null)}
              suppressChange={comparison?.partial}
            />
          </section>
        )}

        {connected && trend.length > 1 && (
          <Trend points={trend} currency={currency} days={days} />
        )}

        {connected && comparison?.partial && (
          <div className="wl-card" style={{ padding: '14px 18px' }}>
            <div className="flex items-start gap-2.5">
              <span
                className="wl-dot shrink-0"
                style={{ background: 'var(--accent-amber)', marginTop: '5px' }}
              />
              <p style={{ fontSize: '12px', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
                Change figures are hidden: the comparison period {comparison.from} →{' '}
                {comparison.to} is only {comparison.coveredDays} day
                {comparison.coveredDays === 1 ? '' : 's'} deep in the archive, so every metric
                would appear to have grown. Pick a shorter window, or raise the sync window in
                Settings and refetch.
              </p>
            </div>
          </div>
        )}

        {/* ── Table ──────────────────────────────────────────────── */}
        {connected && rows.length === 0 && (
          <div className="wl-card py-16 flex flex-col items-center gap-3">
            <p style={{ fontSize: '15px', color: 'var(--ink-secondary)' }}>
              No data in this period.
            </p>
            <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
              {settings?.lastSyncedAt
                ? 'The account had no shopping impressions in this window.'
                : 'The feed is connected, but no data has been fetched yet.'}
            </p>
            <button onClick={refresh} disabled={syncing} className="wl-btn-secondary mt-1">
              {syncing ? 'Fetching…' : 'Fetch data now'}
            </button>
          </div>
        )}

        {connected && rows.length > 0 && (
          <section className="wl-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div
              className="flex items-center justify-between gap-3 flex-wrap"
              style={{ padding: '12px 18px', borderBottom: '1px solid var(--hairline)' }}
            >
              <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
                {query.trim()
                  ? `${formatInt(visible.length)} of ${formatInt(sorted.length)} products`
                  : `${formatInt(sorted.length)} products`}
              </span>
              <div className="flex items-center gap-4 flex-wrap">
                {vatApplies && (
                  <label
                    className="flex items-center gap-1.5"
                    style={{ fontSize: '12px', color: 'var(--ink-secondary)', cursor: 'pointer' }}
                    // Says what it does AND what it does not. This control was
                    // called "Margin incl. VAT", one of two things on the page
                    // with VAT in the name — and the other one is the setting
                    // that actually moves break-even. Ticking this and watching
                    // break-even sit still read as a broken feature.
                    title={`Changes how the Margin column is DISPLAYED, nothing else. Margin is normally taken on prices net of ${vat.rate}% VAT, the basis Shopify's cost per item is on; this shows it on gross prices for reconciling against Shopify. Break-even is unaffected — it always uses the net margin.`}
                  >
                    <input
                      type="checkbox"
                      checked={grossBasis}
                      onChange={(e) => setGrossBasis(e.target.checked)}
                      style={{ accentColor: 'var(--accent-purple)' }}
                    />
                    Margin on gross prices
                  </label>
                )}
                {returnsContext && (
                  <label
                    style={{
                      fontSize: '12px',
                      color: 'var(--ink-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={showReturns}
                      onChange={(e) => setShowReturns(e.target.checked)}
                      style={{ accentColor: 'var(--accent-purple)' }}
                    />
                    Returns
                  </label>
                )}
                {comparison && !comparison.partial && (
                  <label
                    style={{
                      fontSize: '12px',
                      color: 'var(--ink-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      whiteSpace: 'nowrap',
                    }}
                    title={`Adds change columns against ${comparison.from} → ${comparison.to}, the equal-length period immediately before this one.`}
                  >
                    <input
                      type="checkbox"
                      checked={showCompare}
                      onChange={(e) => setShowCompare(e.target.checked)}
                      style={{ accentColor: 'var(--accent-purple)' }}
                    />
                    Compare
                  </label>
                )}
                <SearchBox value={query} onChange={setQuery} placeholder="Search products…" />
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--hairline)' }}>
                    <Th style={{ textAlign: 'left', paddingLeft: '18px' }}>Product</Th>
                    <Th sortable active={sortKey === 'impressions'} dir={sortDir} onClick={() => setSort('impressions')}>
                      Impressions
                    </Th>
                    <Th sortable active={sortKey === 'clicks'} dir={sortDir} onClick={() => setSort('clicks')}>
                      Clicks
                    </Th>
                    <Th sortable active={sortKey === 'cost'} dir={sortDir} onClick={() => setSort('cost')}>
                      Cost
                    </Th>
                    {showCompare && (
                      <Th
                        sortable
                        active={sortKey === 'dCostPct'}
                        dir={sortDir}
                        onClick={() => setSort('dCostPct')}
                      >
                        Δ Cost
                      </Th>
                    )}
                    <Th sortable active={sortKey === 'margin'} dir={sortDir} onClick={() => setSort('margin')}>
                      Margin
                    </Th>
                    <Th sortable active={sortKey === 'roas_value'} dir={sortDir} onClick={() => setSort('roas_value')}>
                      Revenue
                      <CountPill n={activeActions.roas.length} />
                    </Th>
                    {showCompare && (
                      <Th
                        sortable
                        active={sortKey === 'dRevenuePct'}
                        dir={sortDir}
                        onClick={() => setSort('dRevenuePct')}
                      >
                        Δ Revenue
                      </Th>
                    )}
                    <Th sortable active={sortKey === 'roas'} dir={sortDir} onClick={() => setSort('roas')}>
                      ROAS
                    </Th>
                    {showCompare && (
                      <Th
                        sortable
                        active={sortKey === 'dRoasAbs'}
                        dir={sortDir}
                        onClick={() => setSort('dRoasAbs')}
                      >
                        Δ ROAS
                      </Th>
                    )}
                    {showReturns && (
                      <Th sortable active={sortKey === 'netRoas'} dir={sortDir} onClick={() => setSort('netRoas')}>
                        Net ROAS
                      </Th>
                    )}
                    {/* Sits beside whichever ROAS is the operative one, because
                        the number only means something next to the one it is
                        being compared against. */}
                    <Th
                      sortable
                      active={sortKey === 'breakEvenRoas'}
                      dir={sortDir}
                      onClick={() => setSort('breakEvenRoas')}
                    >
                      Break-even
                      {/* Points the column at the setting that governs it. Without
                          this the only clue that break-even is on an unverified
                          basis lives in a footnote, which is not where anyone
                          reading a number is looking. */}
                      {uplift === null && (
                        <span
                          title="Unverified: nobody has said whether Google's conversion value includes VAT, so this assumes it does not — which makes it too low if it does. Set it in the notes below the table."
                          style={{ color: 'var(--accent-amber)', marginLeft: '4px' }}
                        >
                          *
                        </span>
                      )}
                    </Th>
                    <Th sortable active={sortKey === 'poas_value'} dir={sortDir} onClick={() => setSort('poas_value')}>
                      Profit
                      <CountPill n={activeActions.poas.length} />
                    </Th>
                    <Th sortable active={sortKey === 'poas'} dir={sortDir} onClick={() => setSort('poas')}>
                      POAS
                    </Th>
                    {showReturns && (
                      <Th sortable active={sortKey === 'netPoas'} dir={sortDir} onClick={() => setSort('netPoas')}>
                        Net POAS
                      </Th>
                    )}
                    {showReturns && (
                      <Th
                        sortable
                        active={sortKey === 'refundedInWindow'}
                        dir={sortDir}
                        onClick={() => setSort('refundedInWindow')}
                      >
                        Refunded
                      </Th>
                    )}
                    <Th style={{ paddingRight: '18px' }}>Profit − cost</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r, idx) => {
                    const key = r.productRef ?? `unmatched-${idx}`
                    const isOpen = expanded === r.productRef
                    return (
                      <Fragment key={key}>
                        <tr
                          onClick={() => toggle(r.productRef)}
                          style={{
                            borderBottom: '1px solid var(--hairline)',
                            cursor: r.productRef ? 'pointer' : 'default',
                            background: isOpen ? 'var(--bg-surface)' : undefined,
                          }}
                        >
                          <td style={{ padding: '11px 12px 11px 18px', maxWidth: '320px' }}>
                            <div className="flex items-center gap-2.5">
                              <span
                                style={{
                                  color: 'var(--ink-muted)',
                                  fontSize: '10px',
                                  width: '10px',
                                  display: 'inline-block',
                                }}
                              >
                                {r.productRef ? (isOpen ? '▾' : '▸') : ''}
                              </span>
                              <div className="min-w-0">
                                <div className="truncate" style={{ color: 'var(--ink)' }}>
                                  {r.title ?? r.productRef ?? 'Unknown item'}
                                </div>
                                <div style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
                                  {r.unmatched ? (
                                    <span style={{ color: 'var(--accent-amber)' }}>
                                      not found in the catalogue
                                    </span>
                                  ) : (
                                    <>
                                      {`${r.variantCount} variant${r.variantCount === 1 ? '' : 's'}`}
                                      <StockNote stock={r.stock} stale={stockStale} />
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <Td>{formatInt(r.impressions)}</Td>
                          <Td>{formatInt(r.clicks)}</Td>
                          <Td>{formatMoney(r.cost, currency)}</Td>
                          {showCompare && (
                            <Td>
                              <Cell d={r.dCost} invert />
                            </Td>
                          )}
                          <Td>
                            <Margin value={r.margin} coverage={r.marginCoverage} />
                          </Td>
                          <Td>{formatMoney(r.roas_value, currency)}</Td>
                          {showCompare && (
                            <Td>
                              <Cell d={r.dRevenue} />
                            </Td>
                          )}
                          <Td>
                            <Ratio value={r.roas} />
                          </Td>
                          {showCompare && (
                            <Td>
                              {/* Shown as an absolute move, not a percentage:
                                  ROAS is already a ratio, and "+40 %" of a ratio
                                  is a second-order figure nobody reasons in. */}
                              <Cell d={r.dRoas} absolute digits={2} />
                            </Td>
                          )}
                          {showReturns && (
                            <Td>
                              <NetRatio value={r.netRoas} rate={r.returnRate} sample={r.returnSample} />
                            </Td>
                          )}
                          <Td>
                            <BreakEven
                              value={r.breakEvenRoas}
                              margin={r.netMargin}
                              // Judged against the net figure whenever returns
                              // are on screen: telling someone they clear
                              // break-even on gross, while the column beside it
                              // says otherwise, is the wrong kind of quiet.
                              actual={showReturns && r.netRoas !== null ? r.netRoas : r.roas}
                            />
                          </Td>
                          <Td>{formatMoney(r.poas_value, currency)}</Td>
                          <Td>
                            <Ratio value={r.poas} />
                          </Td>
                          {showReturns && (
                            <Td>
                              <NetRatio value={r.netPoas} rate={r.returnRate} sample={r.returnSample} />
                            </Td>
                          )}
                          {showReturns && (
                            <Td>
                              <span
                                style={{
                                  color:
                                    r.refundedInWindow > 0 ? 'var(--ink)' : 'var(--ink-muted)',
                                }}
                              >
                                {r.refundedInWindow > 0
                                  ? formatMoney(r.refundedInWindow, currency)
                                  : '—'}
                              </span>
                            </Td>
                          )}
                          <Td style={{ paddingRight: '18px' }}>
                            <span
                              style={{
                                color:
                                  r.profitAfterAdSpend === null
                                    ? 'var(--ink-muted)'
                                    : r.profitAfterAdSpend >= 0
                                      ? 'var(--ink)'
                                      : 'var(--accent-red)',
                              }}
                            >
                              {formatMoney(r.profitAfterAdSpend, currency)}
                            </span>
                          </Td>
                        </tr>

                        {isOpen && (
                          <tr>
                            <td
                              colSpan={(showReturns ? 14 : 11) + (showCompare ? 3 : 0)}
                              style={{ background: 'var(--bg-surface)', padding: '0 18px 14px 40px' }}
                            >
                              {loadingVariants === r.productRef ? (
                                <p style={{ fontSize: '12px', color: 'var(--ink-muted)', padding: '10px 0' }}>
                                  Loading variants…
                                </p>
                              ) : (
                                <VariantTable
                                  rows={variants[r.productRef ?? ''] ?? []}
                                  currency={currency}
                                  returns={variantReturns}
                                  showReturns={showReturns}
                                  stock={variantStock[r.productRef ?? ''] ?? {}}
                                  stale={stockStale}
                                />
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {query.trim() && visible.length === 0 && (
              <p
                style={{
                  fontSize: '13px',
                  color: 'var(--ink-muted)',
                  padding: '28px 18px',
                  textAlign: 'center',
                }}
              >
                No product matches «{query.trim()}» in this window.
              </p>
            )}
          </section>
        )}

        {/* ── Footnotes that stop the numbers being misread ──────── */}
        {connected && rows.length > 0 && (
          <div className="space-y-1.5" style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
            <p>
              Revenue = {describeActions(activeActions.roas)} · Gross profit ={' '}
              {describeActions(activeActions.poas)}
            </p>
            <p>
              Only cost Google can attribute to a product is included. Performance Max
              spend on non-shopping placements is not counted, so these figures are lower
              than the account&apos;s total cost.
            </p>
            <p>
              Margin is list price minus Shopify&apos;s cost per item — gross margin, before
              shipping, fees and returns. Known for {marginCoverage.withMargin} of{' '}
              {marginCoverage.products} products; the rest show &laquo;—&raquo; because no cost
              is entered, not because the margin is zero. An asterisk means the cost covers
              only some of the product&apos;s variants.
            </p>
            <p>
              Break-even is the ROAS at which gross profit covers the ad cost
              {uplift !== null && uplift !== 1
                ? ` — ${formatRatio(uplift, 2)} ÷ margin, the VAT uplift included so the reported conversion value and the net margin are on one basis`
                : ' — 1 ÷ margin'}
              . Green means the product clears it{showReturns ? ' after returns' : ''}, red means
              it does not. It always uses the net margin, so it does not move when the Margin
              column is flipped to the gross basis. It is a floor and not a target: shipping,
              payment fees and overhead come out after it, so a product sitting just above
              break-even is not yet making money.
            </p>
            {comparison && (
              <p>
                Change figures compare {from} → {to} with {comparison.from} → {comparison.to} —
                the equal-length period immediately before, with no gap and no overlap. A dash
                means the product had no data in the earlier period, which is a start rather than
                a change; those sort last rather than as the largest gain. Δ ROAS is an absolute
                move, so &laquo;+0,80&raquo; means the ratio rose by 0,80.
              </p>
            )}
            {stockContext && <StockBasisNote ctx={stockContext} stale={stockStale} />}
            <VatNote feedId={feedId} vat={vat} uplift={uplift} grossBasis={grossBasis} />
            {showReturns && returnsContext && (
              <ReturnsNote ctx={returnsContext} currency={currency} />
            )}
            {unmatchedCost > 0 && (
              <p style={{ color: 'var(--accent-amber)' }}>
                {formatMoney(unmatchedCost, currency)} could not be matched to a product in
                this feed.
              </p>
            )}
            {settings?.lastSyncedAt && (
              <p>Last fetched {new Date(settings.lastSyncedAt).toLocaleString('da-DK')}</p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  hint,
  change,
  invertChange,
  suppressChange,
}: {
  label: string
  value: string
  tone?: 'good' | 'bad'
  hint?: string
  change?: Delta | null
  /** For metrics where UP is bad — cost, refunds. */
  invertChange?: boolean
  /** Set when the comparison period is too thin to draw a conclusion from. */
  suppressChange?: boolean
}) {
  return (
    <div className="wl-card" style={{ padding: '16px 18px' }}>
      <div className="wl-eyebrow">{label}</div>
      <div
        style={{
          fontSize: '26px',
          fontWeight: 500,
          letterSpacing: '-0.01em',
          marginTop: '6px',
          color:
            tone === 'bad' ? 'var(--accent-red)' : tone === 'good' ? 'var(--ink)' : 'var(--ink)',
        }}
      >
        {value}
      </div>
      {!suppressChange && change && (
        <div style={{ marginTop: '5px' }}>
          <Change d={change} invert={invertChange} />
        </div>
      )}
      {hint && (
        <div style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '4px', lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
    </div>
  )
}

/**
 * A period-over-period change.
 *
 * Two rules it exists to enforce, both of which were easy to get wrong:
 *
 *   DIRECTION IS NOT SENTIMENT. Cost rising and ROAS rising are both "up" and
 *   only one is good news, so `invert` decides the colour rather than the sign.
 *
 *   NO PERCENTAGE FROM A ZERO BASE. A product that spent nothing last period
 *   and something this period has not grown by any percentage; it started. That
 *   reads as "new" and the absolute figure sits in the tooltip.
 */
function Change({ d, invert = false }: { d: Delta; invert?: boolean }) {
  if (d.abs === 0) {
    return <span style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>no change</span>
  }
  const up = d.abs > 0
  const good = invert ? !up : up
  const abs = d.abs.toLocaleString('da-DK', { maximumFractionDigits: 2 })
  return (
    <span
      style={{
        fontSize: '11px',
        color: good ? 'var(--accent-green)' : 'var(--accent-red)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
      title={`${up ? '+' : ''}${abs} vs the previous period`}
    >
      {up ? '▲' : '▼'}{' '}
      {d.pct === null
        ? 'new'
        : `${d.pct > 0 ? '+' : ''}${(d.pct * 100).toLocaleString('da-DK', {
            maximumFractionDigits: 0,
          })} %`}
    </span>
  )
}

/**
 * Daily cost against daily revenue, over the selected window.
 *
 * Deliberately a bar strip and not a line: the series has GAPS — a day the
 * account did not serve produces no row at all — and a line would interpolate
 * straight through them, inventing spend on days that had none. Bars can simply
 * be absent.
 *
 * Both series share one vertical scale, because the whole point of putting them
 * together is seeing revenue sit above or below cost. Scaling each to its own
 * maximum would make every account look break-even.
 */
function Trend({
  points,
  currency,
  days,
}: {
  points: TrendPoint[]
  currency: string
  days: Window
}) {
  const max = Math.max(...points.map((p) => Math.max(p.cost, p.revenue)), 0)
  if (max <= 0) return null

  // A day is only worth its own hover target if there is room for one. Beyond
  // ~120 days the bars are sub-pixel and the strip becomes a shape, not a chart.
  const dense = points.length > 120

  return (
    <section className="wl-card" style={{ padding: '16px 18px' }}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="wl-eyebrow">Daily cost and revenue</div>
        <div className="flex items-center gap-3" style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
          <span className="flex items-center gap-1.5">
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '2px',
                background: 'var(--accent-purple)',
                display: 'inline-block',
              }}
            />
            Cost
          </span>
          <span className="flex items-center gap-1.5">
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '2px',
                background: 'var(--accent-green)',
                display: 'inline-block',
              }}
            />
            Revenue
          </span>
          <span>last {days} days</span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: dense ? '1px' : '2px',
          height: '90px',
          marginTop: '12px',
        }}
      >
        {points.map((p) => (
          <div
            key={p.date}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'flex-end',
              gap: '1px',
              height: '100%',
              minWidth: 0,
            }}
            title={
              dense
                ? undefined
                : `${p.date}\nCost ${formatMoney(p.cost, currency)}\nRevenue ${formatMoney(
                    p.revenue,
                    currency
                  )}\nROAS ${formatRatio(p.roas)}`
            }
          >
            <div
              style={{
                flex: 1,
                height: `${(p.cost / max) * 100}%`,
                background: 'var(--accent-purple)',
                borderRadius: '1px 1px 0 0',
                minHeight: p.cost > 0 ? '1px' : 0,
              }}
            />
            <div
              style={{
                flex: 1,
                height: `${(p.revenue / max) * 100}%`,
                background: 'var(--accent-green)',
                borderRadius: '1px 1px 0 0',
                minHeight: p.revenue > 0 ? '1px' : 0,
              }}
            />
          </div>
        ))}
      </div>

      <div
        className="flex justify-between"
        style={{ fontSize: '11px', color: 'var(--ink-muted)', marginTop: '6px' }}
      >
        <span>{points[0]?.date}</span>
        {/* Days with no activity are absent rather than zero, so the count is
            worth stating: a 30-day window showing 22 bars is a finding. */}
        <span>
          {points.length} day{points.length === 1 ? '' : 's'} with data
        </span>
        <span>{points[points.length - 1]?.date}</span>
      </div>
    </section>
  )
}

function MetricPicker({
  label,
  selected,
  actions,
  currency,
  onChange,
}: {
  label: string
  selected: string[]
  actions: AvailableAction[]
  currency: string
  onChange: (v: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<string[] | null>(null)
  const current = draft ?? selected

  function close() {
    setOpen(false)
    if (draft && (draft.length !== selected.length || draft.some((a) => !selected.includes(a)))) {
      onChange(draft)
    }
    setDraft(null)
  }

  const summary =
    current.length === 0
      ? 'Not selected'
      : current.length === 1
        ? current[0]
        : `${current.length} actions summed`

  return (
    <div className="space-y-1.5" style={{ minWidth: '260px', flex: '1 1 260px' }}>
      <div className="wl-eyebrow">{label}</div>

      <div style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          style={{
            width: '100%',
            padding: '8px 10px',
            borderRadius: '10px',
            border: '1px solid var(--hairline)',
            background: 'var(--bg-base)',
            color: current.length ? 'var(--ink)' : 'var(--ink-muted)',
            fontSize: '13px',
            textAlign: 'left',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span className="truncate" style={{ flex: 1 }}>
            {summary}
          </span>
          <span style={{ color: 'var(--ink-muted)', fontSize: '11px' }}>{open ? '▲' : '▼'}</span>
        </button>

        {open && (
          <>
            <div
              onClick={close}
              style={{ position: 'fixed', inset: 0, zIndex: 20 }}
              aria-hidden
            />
            <div
              style={{
                position: 'absolute',
                zIndex: 21,
                top: 'calc(100% + 6px)',
                left: 0,
                right: 0,
                maxHeight: '320px',
                overflowY: 'auto',
                background: 'var(--bg-base)',
                border: '1px solid var(--hairline)',
                borderRadius: '10px',
              }}
            >
              {actions.map((a) => {
                const on = current.includes(a.name)
                return (
                  <label
                    key={a.name}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '9px',
                      padding: '9px 12px',
                      borderBottom: '0.5px solid var(--hairline)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        setDraft(
                          on ? current.filter((n) => n !== a.name) : [...current, a.name]
                        )
                      }
                      style={{ marginTop: '2px', accentColor: 'var(--accent-purple)' }}
                    />
                    <span style={{ minWidth: 0 }}>
                      <span
                        className="block truncate"
                        style={{ fontSize: '13px', color: 'var(--ink)' }}
                      >
                        {a.name}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
                        {formatMoney(a.value, currency)} · {a.items} items
                      </span>
                    </span>
                  </label>
                )
              })}
              {current.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDraft([])}
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    background: 'none',
                    border: 'none',
                    textAlign: 'left',
                    fontSize: '12px',
                    color: 'var(--ink-muted)',
                    cursor: 'pointer',
                  }}
                >
                  Clear selection
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Both VAT bases, in one editor because they share one rate.
 *
 * The questions are independent — Shopify's prices and Google's conversion
 * value can sit on different bases — but the rate is a property of the market,
 * so asking for it twice would invite two answers to a question with one.
 */
function VatNote({
  feedId,
  vat,
  uplift,
  grossBasis,
}: {
  feedId: string
  vat: {
    pricesIncludeVat: boolean | null
    conversionValueIncludesVat: boolean | null
    rate: number | null
  }
  /**
   * What the column ACTUALLY applied, not what the setting says. The two can
   * only diverge in a state the route refuses to write — "gross, but no usable
   * rate" — and branching on the applied value means the note can never claim
   * a correction the numbers did not receive.
   */
  uplift: number | null
  grossBasis: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  // Tri-state, initialised from the stored value WITHOUT a fallback. These used
  // to be `?? true`, which rendered an unanswered question as an already-ticked
  // box: opening the editor and pressing Save then looked like making a choice
  // while every later attempt re-saved the same value and correctly changed
  // nothing. "Nothing happens when I set it" was the honest report of that.
  const [includes, setIncludes] = useState<boolean | null>(vat.pricesIncludeVat)
  const [convIncludes, setConvIncludes] = useState<boolean | null>(
    vat.conversionValueIncludesVat
  )
  const [rate, setRate] = useState(vat.rate === null ? '25' : String(vat.rate))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const needsRate = includes === true || convIncludes === true
  const unanswered = includes === null || convIncludes === null

  async function save() {
    // Guarded as well as disabled: the button is the only path today, but the
    // route would otherwise receive a null it reads as "leave unchanged".
    if (includes === null || convIncludes === null) return
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/google-ads/${feedId}/vat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pricesIncludeVat: includes,
        conversionValueIncludesVat: convIncludes,
        vatRate: needsRate ? Number(rate) : null,
      }),
    })
    const json = await res.json().catch(() => ({}))
    setSaving(false)
    if (!res.ok) {
      setError((json as { error?: string }).error ?? 'Could not save')
      return
    }
    setEditing(false)
    router.refresh()
  }

  if (editing) {
    return (
      <div className="space-y-2" style={{ paddingTop: '2px' }}>
        <TriChoice
          label="Do Shopify's prices include VAT?"
          value={includes}
          onChange={setIncludes}
        />
        <TriChoice
          label="Does Google's conversion value include VAT?"
          value={convIncludes}
          onChange={setConvIncludes}
          hint="This is the one that moves break-even."
        />
        <div className="flex items-center gap-2 flex-wrap">
          {needsRate && (
            <>
              <input
                type="number"
                step="any"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                aria-label="VAT rate in percent"
                style={{
                  padding: '4px 8px',
                  borderRadius: '8px',
                  border: '1px solid var(--hairline)',
                  background: 'var(--bg-base)',
                  color: 'var(--ink)',
                  fontSize: '12px',
                  width: '64px',
                }}
              />
              <span>%</span>
            </>
          )}
          <button
            onClick={save}
            disabled={saving || unanswered}
            className="wl-btn-primary"
            title={unanswered ? 'Answer both questions first' : undefined}
            style={unanswered ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)} className="wl-btn-secondary">
            Cancel
          </button>
          {error && <span style={{ color: 'var(--accent-red)' }}>{error}</span>}
        </div>
      </div>
    )
  }

  return (
    <>
      {/* ── Do Shopify's prices carry VAT ── */}
      {vat.pricesIncludeVat === null ? (
        // Unanswered. The margin on screen is the overstated one, and says so.
        <p style={{ color: 'var(--accent-amber)' }}>
          Margin is calculated on prices exactly as Shopify stores them. If those include VAT and
          your cost per item does not — the usual setup for a Danish shop — the margin shown is too
          high, and most so where it is thinnest.{' '}
          <button onClick={() => setEditing(true)} style={linkButton}>
            Set the VAT basis
          </button>
        </p>
      ) : !vat.pricesIncludeVat ? (
        <p>
          Shopify prices are net of VAT, so margin needs no adjustment.{' '}
          <button onClick={() => setEditing(true)} style={linkButton}>
            Change
          </button>
        </p>
      ) : (
        <p>
          {grossBasis
            ? `Margin is shown on gross prices, VAT included — for reconciling against Shopify. It overstates profitability, because cost per item is net of VAT.`
            : `Margin is taken on prices net of ${vat.rate}% VAT, the same basis as Shopify's cost per item.`}{' '}
          <button onClick={() => setEditing(true)} style={linkButton}>
            Change
          </button>
        </p>
      )}

      {/* ── Does Google's conversion value carry VAT ── */}
      {uplift === null ? (
        <p style={{ color: 'var(--accent-amber)' }}>
          Break-even is treating Google&apos;s conversion value as net of VAT, because the basis is
          not on record. Shopify&apos;s standard tracking sends the gross order total — if that is
          your setup, every break-even here is too LOW by the VAT rate, and products are being
          marked as clearing a bar they are under.{' '}
          <button onClick={() => setEditing(true)} style={linkButton}>
            Set the conversion value basis
          </button>
        </p>
      ) : uplift > 1 ? (
        <p>
          Google&apos;s conversion value includes {vat.rate}% VAT, so break-even is raised by that
          much to meet the net margin on the same basis.{' '}
          <button onClick={() => setEditing(true)} style={linkButton}>
            Change
          </button>
        </p>
      ) : (
        <p>
          Google&apos;s conversion value is net of VAT, the same basis as the margin, so break-even
          is 1 ÷ margin unadjusted.{' '}
          <button onClick={() => setEditing(true)} style={linkButton}>
            Change
          </button>
        </p>
      )}
    </>
  )
}

/**
 * A yes/no question that is allowed to be UNANSWERED.
 *
 * A checkbox has two states and the question has three. Rendering null as
 * unticked asserts "no"; defaulting it to ticked — which this replaced —
 * asserts "yes" and, worse, makes choosing indistinguishable from finding it
 * already chosen. Someone re-saving what they believe is a change then sees
 * nothing move, because nothing did.
 *
 * Neither pill is active while the answer is null, and the caller keeps Save
 * disabled until both questions have one. Same contract as the columns behind
 * them: absence is not a value.
 */
function TriChoice({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: boolean | null
  onChange: (v: boolean) => void
  hint?: string
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span style={{ color: value === null ? 'var(--accent-amber)' : 'var(--ink-secondary)' }}>
        {label}
      </span>
      <div className="flex gap-1">
        {([true, false] as const).map((opt) => (
          <button
            key={String(opt)}
            type="button"
            onClick={() => onChange(opt)}
            aria-pressed={value === opt}
            className="wl-pill"
            style={{
              cursor: 'pointer',
              background: value === opt ? 'var(--accent-purple)' : 'transparent',
              color: value === opt ? '#fff' : 'var(--ink-muted)',
              border: value === opt ? 'none' : '1px solid var(--hairline)',
            }}
          >
            {opt ? 'Yes' : 'No'}
          </button>
        ))}
      </div>
      {value === null ? (
        <span style={{ color: 'var(--accent-amber)' }}>not answered</span>
      ) : (
        hint && <span style={{ color: 'var(--ink-muted)' }}>{hint}</span>
      )}
    </div>
  )
}

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  color: 'var(--accent-purple)',
  cursor: 'pointer',
}

function ReturnsNote({ ctx, currency }: { ctx: ReturnsContext; currency: string }) {
  return (
    <>
      <p>
        Net ROAS and net POAS are the gross figures reduced by this product&apos;s measured
        return rate — refunded value ÷ sold value for orders placed{' '}
        {ctx.cohortFrom && ctx.cohortTo ? (
          <>
            between {ctx.cohortFrom} and {ctx.cohortTo}
          </>
        ) : (
          'in the matured period'
        )}
        {ctx.country ? ` in ${ctx.country}` : ''}. That period stops 30 days short of today on
        purpose: a return takes weeks to arrive, so counting recent orders would make every
        product look clean. Google is not told any of this — its own numbers are unchanged.
      </p>
      <p>
        &laquo;Refunded&raquo; is different: it is money that actually left in the window
        shown, whatever the age of the order it belonged to. It will not match the net
        columns, and is not supposed to.{' '}
        {ctx.refundedInWindow > 0 && (
          <>
            {formatMoney(ctx.returnedInWindow, currency)} of it was return-driven
            {ctx.otherRefundedInWindow > 0 && (
              <> and {formatMoney(ctx.otherRefundedInWindow, currency)} was cancellations or
              goodwill</>
            )}
            .
          </>
        )}
      </p>
      <p>
        A product shows &laquo;—&raquo; until it has sold at least 20 units in the matured
        period — one return out of three is not a 33% return rate, it is an unknown one.
        {ctx.overallRate !== null && (
          <>
            {' '}
            Across this market the rate is {formatPercent(ctx.overallRate, 1)} on{' '}
            {formatInt(ctx.overallSample)} units, which is context for a product with too few
            of its own — not a substitute for it.
          </>
        )}
      </p>
      {(ctx.archiveHasGap || (ctx.archiveDepthDays ?? 0) < 90) && (
        <p style={{ color: 'var(--accent-amber)' }}>
          {ctx.archiveLastRunAt === null
            ? 'No order history has been captured yet, so no return rate can exist. '
            : `Order history goes back ${ctx.archiveDepthDays ?? 0} days. `}
          Shopify only exposes the last 60 days without the read_all_orders scope, so history
          is built by syncing regularly — and any gap longer than that is permanent.
          {ctx.archiveHasGap && ctx.archiveLastRunAt !== null && ' The sync has lapsed past that window.'}
        </p>
      )}
    </>
  )
}

function NetRatio({
  value,
  rate,
  sample,
}: {
  value: number | null
  rate: number | null
  sample: number
}) {
  if (value === null || rate === null) {
    return (
      <span
        style={{ color: 'var(--ink-muted)' }}
        title={
          sample > 0
            ? `Only ${sample} unit(s) sold in the matured period — too few for a return rate`
            : 'No matured sales for this product yet'
        }
      >
        —
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end' }}>
      <Ratio value={value} />
      <span style={{ fontSize: '10px', color: 'var(--ink-muted)', marginTop: '2px' }}>
        −{formatPercent(rate, 0)}
      </span>
    </span>
  )
}

function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('')
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        style={{
          padding: '6px 10px',
          borderRadius: '10px',
          border: '1px solid var(--hairline)',
          background: 'var(--bg-base)',
          color: 'var(--ink)',
          fontSize: '13px',
          width: '220px',
          maxWidth: '100%',
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          title="Clear"
          aria-label="Clear search"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--ink-muted)',
            cursor: 'pointer',
            fontSize: '15px',
            lineHeight: 1,
            padding: '4px',
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

/**
 * What the stock notes rest on, said once beneath the table.
 *
 * Three separate caveats, and each is only printed when it actually applies —
 * a single-location shop synced this morning gets one short sentence rather
 * than a paragraph of hedging about problems it does not have.
 */
function StockBasisNote({ ctx, stale }: { ctx: StockContext; stale: boolean }) {
  if (!ctx.syncedAt) {
    return (
      <p style={{ color: 'var(--accent-amber)' }}>
        Stock has never been read from Shopify for this feed, so no product shows a stock
        note. Run a product sync to populate it.
      </p>
    )
  }

  return (
    <p style={stale ? { color: 'var(--accent-amber)' } : undefined}>
      Stock is as of {new Date(ctx.syncedAt).toLocaleString('da-DK')}
      {ctx.ageDays !== null && ctx.ageDays > 0
        ? ` — ${ctx.ageDays} day${ctx.ageDays === 1 ? '' : 's'} ago`
        : ''}
      {stale && ', which is old enough that it may have moved since'}. Days of stock is units
      on hand divided by sales over the last {ctx.velocityDays} days, and is only shown once a
      product has sold enough for the rate to mean something — products below that, and
      products Shopify does not track stock for, show nothing rather than a zero.
      {ctx.multipleLocations && ctx.locationCount !== null && (
        <>
          {' '}
          This shop holds stock at {ctx.locationCount} locations and the quantity is the total
          across all of them, so not all of it is necessarily available to this feed&apos;s
          market.
        </>
      )}
      {ctx.locationCount === null && (
        <> The shop&apos;s locations have not been detected yet, so it is not known whether
        this quantity spans more than one.</>
      )}
    </p>
  )
}

/**
 * Stock, folded into the line that already carries the variant count.
 *
 * DELIBERATELY NOT A COLUMN. The table is already fourteen columns wide, and
 * stock is not a result to be compared across products — it is a constraint on
 * whether this row's numbers can still be acted on. It belongs beside the
 * product's identity, not among its metrics.
 *
 * SILENT WHEN THERE IS NOTHING TO SAY. A fully stocked product with a long
 * runway renders nothing at all: every row shouting "in stock" would train the
 * eye to skip the line where it matters. Only the two findings speak — some of
 * it cannot be bought, or what is left runs out soon.
 */
function StockNote({ stock, stale }: { stock: StockView | undefined; stale: boolean }) {
  if (!stock) return null

  // Every branch below reads a value that is null when unknown, so an untracked
  // or unmeasurable product falls through and says nothing — rather than
  // claiming a stock of zero, which is what its raw Shopify payload says.
  const parts: string[] = []

  if (stock.outOfStock) {
    parts.push('out of stock')
  } else if (stock.coverage !== null && stock.coverage < 1) {
    const gone = stock.variantsTotal - stock.variantsSellable
    parts.push(`${gone} of ${stock.variantsTotal} out of stock`)
    // Only when some of it can still be bought: "out of stock, 0 days of
    // stock" says the same thing twice and the second half is noise.
  }

  if (!stock.outOfStock && stock.daysOfStock !== null && stock.daysOfStock < LOW_STOCK_DAYS) {
    parts.push(`${Math.floor(stock.daysOfStock)} days of stock`)
  }

  if (!parts.length) return null

  // Everything reaching here is a finding, so it is all amber. Staleness is
  // marked with an asterisk instead of a second colour — the same convention
  // the break-even column already uses for an unverified VAT basis, and one
  // more colour would compete with the red/green that carries the verdicts.
  return (
    <span
      style={{ color: 'var(--accent-amber)' }}
      title={
        stale
          ? `Stock was last read from Shopify more than ${STALE_STOCK_DAYS} days ago, so it may have moved since.`
          : undefined
      }
    >
      {parts.map((text, i) => (
        <span key={i}>
          {' · '}
          {text}
          {stale && '*'}
        </span>
      ))}
    </span>
  )
}

function Margin({ value, coverage }: { value: number | null; coverage: number }) {
  if (value === null) {
    return <span style={{ color: 'var(--ink-muted)' }}>—</span>
  }
  const partial = coverage > 0 && coverage < 1
  return (
    <span
      title={partial ? `Cost known for ${Math.round(coverage * 100)}% of variants` : undefined}
      style={{ color: value < 0 ? 'var(--accent-red)' : 'var(--ink)' }}
    >
      {formatPercent(value, 0)}
      {partial && <span style={{ color: 'var(--ink-muted)' }}>*</span>}
    </span>
  )
}

/**
 * The ROAS a product must clear before its ads stop costing money.
 *
 * Gross profit is revenue × margin, and break-even is where that equals ad
 * cost — so the threshold is 1 ÷ margin and nothing else. It is a property of
 * the product, not of a campaign: it exists for a product that has never been
 * advertised, and it does not move when spend does.
 *
 * TINTED BY THE VERDICT, NOT BY THE VALUE. A break-even of 3.1 is neither good
 * nor bad on its own — the finding is whether the product is above or below it,
 * and asking someone to do that subtraction across two columns is how it stops
 * being read. Grey whenever either half is unknown: a product with no traffic
 * is not failing its target, it has no verdict yet.
 *
 * Plain text rather than the pill `Ratio` uses, so the threshold cannot be
 * mistaken for another score sitting next to the real one.
 */
function BreakEven({
  value,
  margin,
  actual,
}: {
  value: number | null
  margin: number | null
  actual: number | null
}) {
  if (value === null) {
    // Two very different nulls. A known margin that is zero or negative means
    // no revenue multiple ever repays the spend — a finding worth stating, not
    // absent data. An unknown margin is just unknown.
    const unreachable = margin !== null
    return (
      <span
        style={{ color: unreachable ? 'var(--accent-red)' : 'var(--ink-muted)' }}
        title={
          unreachable
            ? 'No gross margin on this product, so no ROAS breaks even'
            : 'No cost per item entered, so break-even cannot be worked out'
        }
      >
        {unreachable ? '∞' : '—'}
      </span>
    )
  }

  const clears = actual === null ? null : actual >= value
  return (
    <span
      title={
        clears === null
          ? 'No ROAS to compare against yet'
          : clears
            ? 'Above break-even'
            : 'Below break-even — the ads cost more than the gross profit they earn'
      }
      style={{
        color:
          clears === null
            ? 'var(--ink-muted)'
            : clears
              ? 'var(--accent-green)'
              : 'var(--accent-red)',
      }}
    >
      {formatRatio(value)}
    </span>
  )
}

/** Shown beside a column header when more than one action feeds it. */
function CountPill({ n }: { n: number }) {
  if (n < 2) return null
  return (
    <span
      className="wl-pill"
      title={`${n} conversion actions summed`}
      style={{
        marginLeft: '6px',
        background: 'var(--bg-surface)',
        color: 'var(--ink-muted)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      ×{n}
    </span>
  )
}

function Th({
  children,
  sortable,
  active,
  dir,
  onClick,
  style,
}: {
  children: React.ReactNode
  sortable?: boolean
  active?: boolean
  dir?: 1 | -1
  onClick?: () => void
  style?: React.CSSProperties
}) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: '10px 12px',
        textAlign: 'right',
        fontSize: '10px',
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: active ? 'var(--ink)' : 'var(--ink-muted)',
        cursor: sortable ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
      {active && <span style={{ marginLeft: '4px' }}>{dir === 1 ? '↑' : '↓'}</span>}
    </th>
  )
}

function Td({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <td
      style={{
        padding: '11px 12px',
        textAlign: 'right',
        color: 'var(--ink-secondary)',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {children}
    </td>
  )
}

/**
 * A change inside a table cell.
 *
 * Quieter than the Stat card version on purpose — a column of these is read by
 * scanning for colour, and a full-strength green on every row would compete
 * with the numbers it is annotating.
 *
 * A dash means the product had no data in the comparison period. That is
 * different from "no change", and the two must never look alike: one says it
 * did not move, the other says there is nothing to compare against.
 */
function Cell({
  d,
  invert = false,
  absolute = false,
  digits = 0,
}: {
  d: Delta | null
  invert?: boolean
  absolute?: boolean
  digits?: number
}) {
  if (!d) return <span style={{ color: 'var(--ink-muted)' }}>—</span>
  if (d.abs === 0) return <span style={{ color: 'var(--ink-muted)' }}>0</span>

  const up = d.abs > 0
  const good = invert ? !up : up
  const text =
    absolute || d.pct === null
      ? `${up ? '+' : ''}${d.abs.toLocaleString('da-DK', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })}`
      : `${up ? '+' : ''}${(d.pct * 100).toLocaleString('da-DK', { maximumFractionDigits: 0 })} %`

  return (
    <span
      style={{ color: good ? 'var(--accent-green)' : 'var(--accent-red)' }}
      title={
        d.pct === null
          ? 'No comparable figure in the previous period — this is a start, not a percentage change.'
          : `${up ? '+' : ''}${d.abs.toLocaleString('da-DK', { maximumFractionDigits: 2 })} in absolute terms`
      }
    >
      {text}
    </span>
  )
}

function Ratio({ value }: { value: number | null }) {
  if (value === null) return <span style={{ color: 'var(--ink-muted)' }}>—</span>
  return (
    <span
      className="wl-pill"
      style={{
        background: value >= 1 ? 'rgba(31,180,106,0.12)' : 'rgba(224,82,76,0.12)',
        color: value >= 1 ? 'var(--accent-green)' : 'var(--accent-red)',
      }}
    >
      {formatRatio(value)}
    </span>
  )
}

function VariantTable({
  rows,
  currency,
  returns,
  showReturns,
  stock,
  stale,
}: {
  rows: VariantRow[]
  currency: string
  returns: Record<string, { returnRate: number | null; refundedInWindow: number; sampleUnits: number }>
  showReturns: boolean
  /** Every variant of this product, including ones with no ad data. */
  stock: Record<string, VariantStockView>
  stale: boolean
}) {
  // Out of stock AND absent from the performance rows above. Usually the same
  // set: Merchant Center stops serving an unavailable offer, so it drops out of
  // the ads report — which is exactly why naming them here matters. Without
  // this the parent row can say "2 of 5 out of stock" above a list in which
  // every variant looks fine.
  const shown = new Set(rows.map((v) => v.variantRef).filter(Boolean) as string[])
  const missingUnavailable = Object.entries(stock)
    .filter(([ref, s]) => !s.sellable && !shown.has(ref))
    .map(([, s]) => s)

  if (!rows.length && !missingUnavailable.length) {
    return (
      <p style={{ fontSize: '12px', color: 'var(--ink-muted)', padding: '10px 0' }}>
        No variant data in this period.
      </p>
    )
  }
  return (
    <>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <tbody>
        {rows
          .slice()
          .sort((a, b) => b.cost - a.cost)
          .map((v) => {
            const ret = v.variantRef ? returns[v.variantRef] : undefined
            const rate = ret?.returnRate ?? null
            const kept = rate === null ? null : 1 - rate
            const st = v.variantRef ? stock[v.variantRef] : undefined
            return (
              <tr key={v.itemId} style={{ borderBottom: '0.5px solid var(--hairline)' }}>
                <td style={{ padding: '8px 12px 8px 0', color: 'var(--ink-secondary)' }}>
                  {v.options.length ? v.options.join(' · ') : (v.variantTitle ?? v.itemId)}
                  {v.sku && (
                    <span style={{ color: 'var(--ink-muted)', marginLeft: '8px' }}>{v.sku}</span>
                  )}
                  <VariantStockTag stock={st} stale={stale} />
                </td>
                <Td>{formatInt(v.impressions)}</Td>
                <Td>{formatInt(v.clicks)}</Td>
                <Td>{formatMoney(v.cost, currency)}</Td>
                <Td>{formatMoney(v.roas_value, currency)}</Td>
                <Td>
                  <Ratio value={v.roas} />
                </Td>
                {showReturns && (
                  <Td>
                    <NetRatio
                      value={kept === null || v.roas === null ? null : v.roas * kept}
                      rate={rate}
                      sample={ret?.sampleUnits ?? 0}
                    />
                  </Td>
                )}
                <Td>{formatMoney(v.poas_value, currency)}</Td>
                <Td style={{ paddingRight: showReturns ? '12px' : 0 }}>
                  <Ratio value={v.poas} />
                </Td>
                {showReturns && (
                  <Td style={{ paddingRight: 0 }}>
                    <NetRatio
                      value={kept === null || v.poas === null ? null : v.poas * kept}
                      rate={rate}
                      sample={ret?.sampleUnits ?? 0}
                    />
                  </Td>
                )}
              </tr>
            )
          })}
      </tbody>
    </table>

    {missingUnavailable.length > 0 && (
      <p
        style={{
          fontSize: '11px',
          color: 'var(--accent-amber)',
          padding: '9px 0 2px',
          lineHeight: 1.5,
        }}
      >
        Out of stock, with no traffic in this period:{' '}
        {missingUnavailable
          .map((s) => s.title ?? s.sku ?? 'unnamed variant')
          .join(' · ')}
        {stale && '*'}
        <span style={{ color: 'var(--ink-muted)' }}>
          {' — '}Google stops serving an offer once it goes unavailable, so these usually
          disappear from the report rather than showing zero.
        </span>
      </p>
    )}
    </>
  )
}

/**
 * A variant's stock, beside its name in the drill-down.
 *
 * Silent unless there is a finding, for the same reason StockNote is: a column
 * of "in stock" teaches the eye to skip the line. Unavailable is stated
 * outright; a short runway is stated only when the variant can still be bought.
 */
function VariantStockTag({ stock, stale }: { stock: VariantStockView | undefined; stale: boolean }) {
  if (!stock) return null

  const label = !stock.sellable
    ? 'out of stock'
    : stock.daysOfStock !== null && stock.daysOfStock < LOW_STOCK_DAYS
      ? `${Math.floor(stock.daysOfStock)} days of stock`
      : null

  if (!label) return null

  return (
    <span
      style={{ color: 'var(--accent-amber)', marginLeft: '8px' }}
      title={
        stale
          ? `Stock was last read from Shopify more than ${STALE_STOCK_DAYS} days ago, so it may have moved since.`
          : stock.quantity !== null
            ? `${stock.quantity} in stock`
            : undefined
      }
    >
      {label}
      {stale && '*'}
    </span>
  )
}
