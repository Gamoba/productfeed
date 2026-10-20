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

  return (
    <>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="space-y-1.5">
          <h1
            style={{
              fontSize: '34px',
              fontWeight: 500,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
            }}
          >
            Campaigns
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            {from} → {to} · compared with {comparison.from} → {comparison.to}
          </p>
        </div>
        <div className="flex gap-1">
          {windows.map((w) => (
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

      {/* ── Coverage: the number the waste page used to carry as a caveat ── */}
      <section className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
        <Stat label="Attributed to products" value={formatMoney(attributed, currency)} />
        <Stat
          label="Total campaign spend"
          value={realSpend > 0 ? formatMoney(realSpend, currency) : '—'}
          hint={
            realSpend > 0
              ? undefined
              : 'Campaign totals have not been fetched for this period, so the real spend is unknown — not zero.'
          }
        />
        <Stat
          label="Not reaching products"
          value={unattributed === null ? '—' : formatMoney(unattributed, currency)}
          tone={unattributed !== null && unattributed > 0 ? 'warn' : undefined}
          hint="Spend on placements that carry no product — typical for Performance Max. Invisible to every product-level report in this app."
        />
        <Stat
          label="Coverage"
          value={coverage === null ? '—' : formatPercent(coverage)}
          hint="How much of the real campaign spend the product tables can see."
        />
        <Stat label="Campaigns" value={formatInt(rows.filter((r) => !r.isSentinel).length)} />
      </section>

      {/* ── Table ──────────────────────────────────────────────────── */}
      {rows.length === 0 ? (
        <div className="wl-card py-16 flex flex-col items-center gap-3">
          <p style={{ fontSize: '15px', color: 'var(--ink-secondary)' }}>
            No campaign data in this period.
          </p>
          <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            {lastSyncedAt
              ? 'Campaigns are recorded from the sync onwards. Refresh the data on Performance to fill this in.'
              : 'The feed is connected, but no data has been fetched yet.'}
          </p>
          <Link href={`/feed/${feedId}/google-ads?days=${days}`} className="wl-btn-secondary mt-1">
            Go to Performance →
          </Link>
        </div>
      ) : (
        <section className="wl-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--hairline)' }}>
                  <Th style={{ textAlign: 'left', paddingLeft: '18px' }}>Campaign</Th>
                  <Th sortable active={sortKey === 'cost'} dir={sortDir} onClick={() => setSort('cost')}>
                    Cost on products
                  </Th>
                  <Th
                    sortable
                    active={sortKey === 'totalCost'}
                    dir={sortDir}
                    onClick={() => setSort('totalCost')}
                  >
                    Total spend
                  </Th>
                  <Th
                    sortable
                    active={sortKey === 'coverage'}
                    dir={sortDir}
                    onClick={() => setSort('coverage')}
                  >
                    Coverage
                  </Th>
                  <Th sortable active={sortKey === 'clicks'} dir={sortDir} onClick={() => setSort('clicks')}>
                    Clicks
                  </Th>
                  <Th sortable active={sortKey === 'roas'} dir={sortDir} onClick={() => setSort('roas')}>
                    ROAS
                  </Th>
                  <Th sortable active={sortKey === 'poas'} dir={sortDir} onClick={() => setSort('poas')}>
                    POAS
                  </Th>
                  <Th
                    sortable
                    active={sortKey === 'products'}
                    dir={sortDir}
                    onClick={() => setSort('products')}
                  >
                    Products
                  </Th>
                  <Th style={{ paddingRight: '18px' }}>vs. previous</Th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const costDelta = delta(r.cost, previousCost[r.campaignId] ?? null)
                  const roasDelta = delta(r.roas, previousRoas[r.campaignId] ?? null)
                  return (
                    <tr key={r.campaignId} style={{ borderBottom: '1px solid var(--hairline)' }}>
                      <td style={{ padding: '11px 12px 11px 18px', maxWidth: '360px' }}>
                        <div className="min-w-0">
                          <div className="truncate" style={{ color: 'var(--ink)' }}>
                            {r.isSentinel
                              ? 'Before campaign tracking'
                              : r.isUnknown
                                ? 'No campaign reported'
                                : (r.name ?? r.campaignId)}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
                            {r.isSentinel ? (
                              <span style={{ color: 'var(--accent-amber)' }}>
                                synced before campaigns were recorded
                              </span>
                            ) : (
                              <>
                                {describeChannel(r.channelType)}
                                {r.status && r.status !== 'ENABLED' ? ` · ${r.status.toLowerCase()}` : ''}
                              </>
                            )}
                          </div>
                        </div>
                      </td>
                      <Td>{formatMoney(r.cost, currency)}</Td>
                      <Td>
                        <span style={{ color: r.totalCost === null ? 'var(--ink-muted)' : 'var(--ink)' }}>
                          {r.totalCost === null ? '—' : formatMoney(r.totalCost, currency)}
                        </span>
                      </Td>
                      <Td>
                        <Coverage value={r.coverage} />
                      </Td>
                      <Td>{formatInt(r.clicks)}</Td>
                      <Td>
                        <Ratio value={r.roas} />
                      </Td>
                      <Td>
                        <Ratio value={r.poas} />
                      </Td>
                      <Td>{formatInt(r.products)}</Td>
                      <Td style={{ paddingRight: '18px' }}>
                        <div className="flex flex-col items-end gap-0.5">
                          <DeltaChip d={costDelta} label="cost" invert />
                          <DeltaChip d={roasDelta} label="ROAS" />
                        </div>
                      </Td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Overlap ────────────────────────────────────────────────── */}
      {overlaps.length > 0 && (
        <section className="wl-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--ink)' }}>
              Products served by more than one campaign
            </h2>
            <p
              style={{
                fontSize: '12px',
                color: 'var(--ink-muted)',
                marginTop: '4px',
                maxWidth: '78ch',
                lineHeight: 1.5,
              }}
            >
              {formatInt(overlapTotal)} product{overlapTotal === 1 ? '' : 's'} took budget from
              several campaigns in this window
              {overlapTotal > overlaps.length ? `, showing the ${overlaps.length} largest` : ''}.
              This is often deliberate — a branded campaign and a catch-all routinely overlap — so
              it is a list to look at, not a list to act on. What matters is whether the split is
              the one you intended.
            </p>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <tbody>
                {overlaps.map((o) => (
                  <tr key={o.productRef} style={{ borderBottom: '1px solid var(--hairline)' }}>
                    <td style={{ padding: '11px 12px 11px 18px', maxWidth: '320px' }}>
                      <div className="truncate" style={{ color: 'var(--ink)' }}>
                        {o.title ?? o.productRef}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
                        {o.campaigns.length} campaigns · {formatMoney(o.totalCost, currency)}
                      </div>
                    </td>
                    <td style={{ padding: '11px 18px 11px 12px' }}>
                      <div className="flex flex-wrap gap-1.5 justify-end">
                        {o.campaigns.map((c) => (
                          <span
                            key={c.campaignId}
                            className="wl-pill"
                            style={{
                              border: '1px solid var(--hairline)',
                              color: 'var(--ink-secondary)',
                              fontSize: '11px',
                            }}
                            title={describeChannel(c.channelType)}
                          >
                            {c.name ?? c.campaignId} · {formatMoney(c.cost, currency)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Footnotes ──────────────────────────────────────────────── */}
      <div className="space-y-1.5" style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
        <p>
          <strong style={{ color: 'var(--ink-secondary)', fontWeight: 500 }}>Cost on products</strong>{' '}
          is what Google attributed to a Merchant Center offer in this feed.{' '}
          <strong style={{ color: 'var(--ink-secondary)', fontWeight: 500 }}>Total spend</strong> is
          what the campaign actually cost, every placement included. ROAS and POAS are computed
          against the attributed cost only, so for a campaign with low coverage they describe the
          shopping slice of it and not the whole campaign.
        </p>
        {feedLabel && (
          <p style={{ color: 'var(--accent-amber)' }}>
            This feed is scoped to the «{feedLabel}» feed label. A campaign&apos;s total spend
            cannot be split by feed label, so it is not fetched and every Total spend reads
            &laquo;—&raquo;. The attributed figures are correct and remain scoped to this feed.
          </p>
        )}
        {comparison.partial && (
          <p style={{ color: 'var(--accent-amber)' }}>
            The comparison period {comparison.from} → {comparison.to} is only{' '}
            {comparison.coveredDays} day{comparison.coveredDays === 1 ? '' : 's'} deep in the
            archive, so the change figures overstate growth. Widen the sync window and refetch to
            fill it in.
          </p>
        )}
        {hasSentinel && (
          <p style={{ color: 'var(--accent-amber)' }}>
            Some of this window was synced before campaigns were recorded and appears under
            &laquo;Before campaign tracking&raquo;. Refreshing the data on Performance replaces it
            with real campaigns.
          </p>
        )}
        <p>
          Revenue and gross profit use the conversion actions chosen on the Performance page, so
          the definitions here and there always agree.
        </p>
      </div>
    </>
  )
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone?: 'warn'
  hint?: string
}) {
  return (
    <div className="wl-card" style={{ padding: '16px 18px' }} title={hint}>
      <div className="wl-eyebrow">{label}</div>
      <div
        style={{
          fontSize: '24px',
          fontWeight: 500,
          letterSpacing: '-0.02em',
          marginTop: '6px',
          color: tone === 'warn' ? 'var(--accent-amber)' : 'var(--ink)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  )
}

/**
 * A period-over-period change.
 *
 * `invert` flips which direction is green. Cost going UP is not good news and
 * ROAS going up is, and a component that painted both the same colour would be
 * training the eye to read the wrong thing.
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
    return (
      <span style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
        {d ? `${label} unchanged` : `${label} —`}
      </span>
    )
  }
  const up = d.abs > 0
  const good = invert ? !up : up
  return (
    <span
      style={{
        fontSize: '11px',
        color: good ? 'var(--accent-green)' : 'var(--accent-red)',
        fontVariantNumeric: 'tabular-nums',
      }}
      // The absolute change is always available even when the percentage is
      // not: a previous value of zero has no percentage, and inventing one is
      // how "+100 %" ends up meaning nothing.
      title={`${label}: ${d.abs > 0 ? '+' : ''}${d.abs.toLocaleString('da-DK', { maximumFractionDigits: 2 })}`}
    >
      {up ? '▲' : '▼'} {label}{' '}
      {d.pct === null
        ? 'new'
        : `${d.pct > 0 ? '+' : ''}${(d.pct * 100).toLocaleString('da-DK', { maximumFractionDigits: 0 })} %`}
    </span>
  )
}

function Coverage({ value }: { value: number | null }) {
  if (value === null) return <span style={{ color: 'var(--ink-muted)' }}>—</span>
  // Under half the spend reaching products is the case where a ROAS in the
  // next column is describing a minority of the campaign, so it is flagged
  // where the reader is looking rather than in a footnote.
  const low = value < 0.5
  return (
    <span
      style={{ color: low ? 'var(--accent-amber)' : 'var(--ink)' }}
      title={
        low
          ? 'Less than half this campaign’s spend reached a product in this feed, so its ROAS and POAS describe only part of it.'
          : undefined
      }
    >
      {formatPercent(value, 0)}
    </span>
  )
}

function Ratio({ value }: { value: number | null }) {
  return (
    <span
      style={{
        color:
          value === null ? 'var(--ink-muted)' : value >= 1 ? 'var(--ink)' : 'var(--accent-red)',
      }}
    >
      {formatRatio(value)}
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
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        color: active ? 'var(--ink)' : 'var(--ink-muted)',
        cursor: sortable ? 'pointer' : 'default',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
      {sortable && active && <span style={{ marginLeft: '4px' }}>{dir === 1 ? '↑' : '↓'}</span>}
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
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </td>
  )
}
