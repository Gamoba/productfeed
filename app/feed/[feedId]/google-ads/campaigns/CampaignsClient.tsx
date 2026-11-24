'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import {
  delta,
  formatInt,
  formatMoney,
  formatPercent,
  formatRatio,
  type ActionChoice,
  type Window,
} from '@/lib/googleAdsAnalytics'
import { describeChannel, type CampaignRow, type Overlap } from '@/lib/googleAdsCampaigns'
import './campaigns.css'

// Feed › Campaigns (reference: references/feed_campaigns.jpg). Which campaigns
// use the feed, and how much of their spend actually reaches a product. The
// one Kobolt card is the spend that doesn't: invisible to every product-level
// report in the app.

type OverlapRow = Overlap & { title: string | null }

type Props = {
  feedId: string
  days: Window
  windows: Window[]
  currency: string
  rows: CampaignRow[]
  previousCost: Record<string, number>
  previousRoas: Record<string, number | null>
  comparison: { from: string; to: string; partial: boolean; coveredDays: number }
  overlaps: OverlapRow[]
  overlapTotal: number
  activeActions: ActionChoice
  feedLabel: string | null
  from: string
  to: string
  lastSyncedAt: string | null
}

type SortKey = 'cost' | 'totalCost' | 'roas' | 'poas' | 'clicks' | 'products' | 'coverage'

function compare(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return (a - b) * dir
}

export function CampaignsClient({
  feedId,
  days,
  windows,
  currency,
  rows,
  previousCost,
  previousRoas,
  comparison,
  overlaps,
  overlapTotal,
  activeActions,
  feedLabel,
  from,
  to,
  lastSyncedAt,
}: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('cost')
  const [sortDir, setSortDir] = useState<1 | -1>(-1)

  const hrefFor = (w: Window) => {
    const p = new URLSearchParams()
    p.set('days', String(w))
    for (const a of activeActions.roas) p.append('roas', a)
    for (const a of activeActions.poas) p.append('poas', a)
    return `/feed/${feedId}/google-ads/campaigns?${p.toString()}`
  }

  const sorted = useMemo(() => {
    const copy = [...rows]
    copy.sort((a, b) => compare(a[sortKey], b[sortKey], sortDir))
    return copy
  }, [rows, sortKey, sortDir])

  function setSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1))
    else {
      setSortKey(key)
      setSortDir(-1)
    }
  }

  const attributed = rows.reduce((n, r) => n + r.cost, 0)
  // Summed only over campaigns that HAVE a total. Falling back to the
  // attributable cost for the rest would quietly close the very gap this
  // number exists to show.
  const withTotal = rows.filter((r) => r.totalCost !== null)
  const realSpend = withTotal.reduce((n, r) => n + (r.totalCost ?? 0), 0)
  const attributedWithinTotal = withTotal.reduce((n, r) => n + r.cost, 0)
  const coverage = realSpend > 0 ? attributedWithinTotal / realSpend : null
  const unattributed = realSpend > 0 ? realSpend - attributedWithinTotal : null
  const hasSentinel = rows.some((r) => r.isSentinel && (r.cost > 0 || r.impressions > 0))
  const campaignCount = rows.filter((r) => !r.isSentinel).length

  const sortTh = (key: SortKey, label: string) => (
    <th className="r">
      <button type="button" className={`cp-sort${sortKey === key ? ' on' : ''}`} onClick={() => setSort(key)}>
        {label}
        {sortKey === key && <span aria-hidden="true">{sortDir === 1 ? ' ↑' : ' ↓'}</span>}
      </button>
    </th>
  )

  return (
    <div className="cp">
      <div className="cp-head">
        <div>
          <h1>Campaigns</h1>
          <p className="cp-lede">
            See which campaigns use the feed, and how much of their spend actually reaches products. {from} → {to},
            compared with {comparison.from} → {comparison.to}.
          </p>
        </div>
        <div className="cp-seg" role="group" aria-label="Period">
          {windows.map((w) => (
            <Link key={w} href={hrefFor(w)} aria-current={w === days ? 'true' : undefined}>
              {w}d
            </Link>
          ))}
        </div>
      </div>

      <div className="cp-top">
        <section className="card cp-stats">
          <div>
            <span>Spend on products</span>
            <strong className="num">{formatMoney(attributed, currency)}</strong>
            <small>what Google has attributed to a product in the feed</small>
          </div>
          <div>
            <span>Total campaign spend</span>
            <strong className="num">{realSpend > 0 ? formatMoney(realSpend, currency) : '—'}</strong>
            <small>{realSpend > 0 ? 'all placements included' : 'not fetched for the period, so unknown (not zero)'}</small>
          </div>
          <div>
            <span>Campaigns</span>
            <strong className="num">{formatInt(campaignCount)}</strong>
            <small>with figures in the period</small>
          </div>
        </section>

        <section className="card hi cp-hi">
          <span className="cp-hi-l">Not reaching products</span>
          <strong className="num">{unattributed === null ? '—' : formatMoney(unattributed, currency)}</strong>
          <span className="cp-bar" aria-hidden="true">
            <i style={{ width: `${coverage === null ? 0 : Math.round(coverage * 100)}%` }} />
          </span>
          <small>
            {coverage === null
              ? 'Total campaign spend has not been fetched, so coverage cannot be calculated.'
              : `${formatPercent(coverage, 0)} of spend reaches a product. The rest goes to placements without a product, typically in Performance Max, and does not appear in any of the app's product reports.`}
          </small>
        </section>
      </div>

      {rows.length === 0 ? (
        <section className="card cp-empty">
          <p>No campaign figures in the period.</p>
          <p className="cp-muted">
            {lastSyncedAt
              ? 'Campaigns are recorded from the sync onwards. Fetch figures on Performance to fill the page.'
              : 'The feed is connected, but no figures have been fetched yet.'}
          </p>
          <Link href={`/feed/${feedId}/google-ads?days=${days}`} className="wl-btn-secondary">
            Go to Performance
          </Link>
        </section>
      ) : (
        <section className="card flush">
          <div className="cp-tablewrap">
            <table className="cp-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  {sortTh('cost', 'Spend on products')}
                  {sortTh('totalCost', 'Total spend')}
                  {sortTh('coverage', 'Coverage')}
                  {sortTh('clicks', 'Clicks')}
                  {sortTh('roas', 'ROAS')}
                  {sortTh('poas', 'POAS')}
                  {sortTh('products', 'Products')}
                  <th className="r">Vs. previous period</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const costDelta = delta(r.cost, previousCost[r.campaignId] ?? null)
                  const roasDelta = delta(r.roas, previousRoas[r.campaignId] ?? null)
                  return (
                    <tr key={r.campaignId}>
                      <td>
                        <span className="cp-name">
                          <b>
                            {r.isSentinel
                              ? 'Before campaign tracking'
                              : r.isUnknown
                                ? 'No campaign reported'
                                : (r.name ?? r.campaignId)}
                          </b>
                          <small>
                            {r.isSentinel ? (
                              <span className="neg">synced before campaigns were recorded</span>
                            ) : (
                              <>
                                {describeChannel(r.channelType)}
                                {r.status && r.status !== 'ENABLED' ? ` · ${r.status.toLowerCase()}` : ''}
                              </>
                            )}
                          </small>
                        </span>
                      </td>
                      <td className="r num">{formatMoney(r.cost, currency)}</td>
                      <td className="r num">
                        {r.totalCost === null ? <span className="cp-muted">—</span> : formatMoney(r.totalCost, currency)}
                      </td>
                      <td className="r">
                        <Coverage value={r.coverage} />
                      </td>
                      <td className="r num">{formatInt(r.clicks)}</td>
                      <td className="r num">
                        <Ratio value={r.roas} />
                      </td>
                      <td className="r num">
                        <Ratio value={r.poas} />
                      </td>
                      <td className="r num">{formatInt(r.products)}</td>
                      <td className="r">
                        <span className="cp-deltas">
                          <DeltaChip d={costDelta} label="spend" invert />
                          <DeltaChip d={roasDelta} label="ROAS" />
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {overlaps.length > 0 && (
        <section className="card flush">
          <div className="cp-card-h">
            <h3>Products getting budget from several campaigns</h3>
            <small>
              {formatInt(overlapTotal)} {overlapTotal === 1 ? 'product' : 'products'} got budget from several campaigns in the period
              {overlapTotal > overlaps.length ? `. Showing the ${overlaps.length} largest` : ''}. This is often deliberate, e.g. a
              brand campaign and a catch-all. Use the list to check the split is the one you want.
            </small>
          </div>
          <ul className="cp-overlaps">
            {overlaps.map((o) => (
              <li key={o.productRef}>
                <span className="cp-name">
                  <b>{o.title ?? o.productRef}</b>
                  <small>
                    {o.campaigns.length} campaigns · {formatMoney(o.totalCost, currency)}
                  </small>
                </span>
                <span className="cp-chips">
                  {o.campaigns.map((c) => (
                    <span key={c.campaignId} className="pill" title={describeChannel(c.channelType)}>
                      {c.name ?? c.campaignId} · {formatMoney(c.cost, currency)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="cp-notes">
        <p>
          <b>Spend on products</b> is what Google has attributed to a product in this feed. <b>Total spend</b> is what
          the campaign actually cost, all placements included. ROAS and POAS are calculated on spend on products only, so
          for a campaign with low coverage they describe the Shopping part, not the whole campaign.
        </p>
        {feedLabel && (
          <p className="neg">
            The feed is limited to the feed label «{feedLabel}». A campaign&apos;s total spend cannot be split by feed
            label, so it is not fetched, and Total spend shows «—». The product figures are correct and belong to this
            feed.
          </p>
        )}
        {comparison.partial && (
          <p className="neg">
            The comparison period {comparison.from} → {comparison.to} has only {comparison.coveredDays}{' '}
            {comparison.coveredDays === 1 ? 'day' : 'days'} in the archive, so the changes look bigger than they are.
            Widen the sync window and fetch figures again.
          </p>
        )}
        {hasSentinel && (
          <p className="neg">
            Part of the period was synced before campaigns were recorded and is shown under «Before campaign tracking».
            Fetch figures on Performance to replace it with real campaigns.
          </p>
        )}
        <p>Revenue and gross profit use the conversion actions selected on Performance.</p>
      </div>
    </div>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

/**
 * A period-over-period change. `invert` flips which direction is green: cost
 * going up is not good news, ROAS going up is.
 */
function DeltaChip({
  d,
  label,
  invert = false,
}: {
  d: { abs: number; pct: number | null } | null
  label: string
  invert?: boolean
}) {
  if (!d || (d.abs === 0 && d.pct === 0)) {
    return <span className="cp-muted cp-d">{d ? `${label} unchanged` : `${label} —`}</span>
  }
  const up = d.abs > 0
  const good = invert ? !up : up
  return (
    <span
      className={`cp-d ${good ? 'pos' : 'neg'}`}
      // The absolute change is always available even when the percentage is
      // not: a previous value of zero has no percentage.
      title={`${label}: ${d.abs > 0 ? '+' : ''}${d.abs.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`}
    >
      {up ? '▲' : '▼'} {label}{' '}
      {d.pct === null
        ? 'new'
        : `${d.pct > 0 ? '+' : ''}${(d.pct * 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}%`}
    </span>
  )
}

function Coverage({ value }: { value: number | null }) {
  if (value === null) return <span className="cp-muted">—</span>
  // Under half reaching products: the ROAS beside it describes a minority of
  // the campaign, so it is flagged where the reader is looking.
  const low = value < 0.5
  return (
    <span
      className="cp-cov"
      title={low ? 'Less than half of the campaign\'s spend reached a product in the feed, so ROAS and POAS describe only part of it.' : undefined}
    >
      <span className="cp-cov-bar" aria-hidden="true">
        <i className={low ? 'low' : undefined} style={{ width: `${Math.round(value * 100)}%` }} />
      </span>
      <span className={`num${low ? ' neg' : ''}`}>{formatPercent(value, 0)}</span>
    </span>
  )
}

function Ratio({ value }: { value: number | null }) {
  if (value === null) return <span className="cp-muted">{formatRatio(value)}</span>
  return <span className={value >= 1 ? undefined : 'neg'}>{formatRatio(value)}</span>
}
