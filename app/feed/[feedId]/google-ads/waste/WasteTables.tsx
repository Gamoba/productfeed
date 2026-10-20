'use client'

import { useMemo, useState } from 'react'
import { formatInt, formatMoney, formatPercent } from '@/lib/googleAdsAnalytics'

export type WasteRow = {
  productRef: string | null
  title: string | null
  handle: string | null
  vendor: string | null
  productType: string | null
  impressions: number
  clicks: number
  cost: number
  poasValue: number
  profitAfterAdSpend: number | null
  /** From the catalogue, so the unavailable table can say how much is gone. */
  variantsTotal: number
}

const ROW_LIMIT = 200

type Props = {
  days: number
  currency: string | null
  wasted: WasteRow[]
  wastedCost: number
  losing: WasteRow[]
  losingCost: number
  showLosing: boolean
  /** Products with spend that cannot be bought RIGHT NOW — see the page. */
  unavailable: WasteRow[]
  unavailableCost: number
  stockSyncedAt: string | null
  stockAgeDays: number | null
  wastedEmpty: React.ReactNode
}

export function WasteTables({
  days,
  currency,
  wasted,
  wastedCost,
  losing,
  losingCost,
  showLosing,
  unavailable,
  unavailableCost,
  stockSyncedAt,
  stockAgeDays,
  wastedEmpty,
}: Props) {
  const [query, setQuery] = useState('')

  const filter = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (rows: WasteRow[]) => {
      if (!terms.length) return rows
      return rows.filter((r) => {
        const hay = [r.title, r.productRef, r.handle, r.vendor, r.productType]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }
  }, [query])

  const wastedShown = filter(wasted)
  const losingShown = filter(losing)
  const unavailableShown = filter(unavailable)
  const searching = query.trim().length > 0

  return (
    <>
      {(wasted.length > 0 || losing.length > 0 || unavailable.length > 0) && (
        <div className="flex justify-end">
          <SearchBox value={query} onChange={setQuery} />
        </div>
      )}

      {/* ── Spending on something nobody can buy ──────────────────── */}
      {unavailable.length > 0 && (
        <Table
          title="Spend on unavailable stock"
          note={`Out of stock now · ${formatMoney(unavailableCost, currency)} spent in the last ${days} days`}
          head={['Product', 'Variants', 'Clicks', 'Cost']}
          shown={Math.min(unavailableShown.length, ROW_LIMIT)}
          total={unavailableShown.length}
          filtered={searching}
          emptyNote={
            searching && unavailableShown.length === 0
              ? `No product here matches «${query.trim()}». ${unavailable.length} are out of stock.`
              : undefined
          }
          // The one caveat that decides whether this table can be acted on at
          // all: it pairs a window of spend with stock as of one moment.
          footnote={
            stockSyncedAt
              ? `Stock is as of ${new Date(stockSyncedAt).toLocaleString('da-DK')}` +
                (stockAgeDays !== null && stockAgeDays > 0
                  ? ` — ${stockAgeDays} day${stockAgeDays === 1 ? '' : 's'} ago`
                  : '') +
                `. The cost is the full ${days} days, so most of it was probably spent while the product was still in stock — this is a list of budget going somewhere unshippable today, not a list of money already lost.`
              : undefined
          }
        >
          {unavailableShown.slice(0, ROW_LIMIT).map((r) => (
            <tr key={r.productRef} style={{ borderBottom: '0.5px solid var(--hairline)' }}>
              <Td left>{r.title ?? r.productRef}</Td>
              <Td muted>{r.variantsTotal > 0 ? `0 of ${r.variantsTotal}` : '—'}</Td>
              <Td>{formatInt(r.clicks)}</Td>
              <Td strong tone="bad">
                {formatMoney(r.cost, currency)}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {/* ── Converting, and still underwater ──────────────────────── */}
      {showLosing && losing.length > 0 && (
        <Table
          title="Converting, but losing money"
          note={`Gross profit below ad spend · ${formatMoney(losingCost, currency)} in total`}
          head={['Product', 'Cost', 'Gross profit', 'Profit − cost']}
          shown={Math.min(losingShown.length, ROW_LIMIT)}
          total={losingShown.length}
          filtered={searching}
          emptyNote={
            searching && losingShown.length === 0
              ? `No product here matches «${query.trim()}». ${losing.length} convert at a loss.`
              : undefined
          }
        >
          {losingShown.slice(0, ROW_LIMIT).map((r) => (
            <tr key={r.productRef} style={{ borderBottom: '0.5px solid var(--hairline)' }}>
              <Td left>{r.title ?? r.productRef}</Td>
              <Td>{formatMoney(r.cost, currency)}</Td>
              <Td>{formatMoney(r.poasValue, currency)}</Td>
              <Td strong tone="bad">
                {formatMoney(r.profitAfterAdSpend, currency)}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {/* ── Spend with nothing to show ────────────────────────────── */}
      {wasted.length === 0 ? (
        wastedEmpty
      ) : (
        <Table
          title="Spend with no revenue"
          note={`${days} days · sorted by spend`}
          head={['Product', 'Impressions', 'Clicks', 'Cost', 'Share']}
          shown={Math.min(wastedShown.length, ROW_LIMIT)}
          total={wastedShown.length}
          filtered={searching}
          emptyNote={
            searching && wastedShown.length === 0
              ? `No product here matches «${query.trim()}». ${wasted.length} products took budget without returning revenue.`
              : undefined
          }
        >
          {wastedShown.slice(0, ROW_LIMIT).map((r) => (
            <tr key={r.productRef} style={{ borderBottom: '0.5px solid var(--hairline)' }}>
              <Td left>{r.title ?? r.productRef}</Td>
              <Td>{formatInt(r.impressions)}</Td>
              <Td>{formatInt(r.clicks)}</Td>
              <Td strong>{formatMoney(r.cost, currency)}</Td>
              <Td muted>{wastedCost > 0 ? formatPercent(r.cost / wastedCost, 0) : '—'}</Td>
            </tr>
          ))}
        </Table>
      )}
    </>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('')
        }}
        placeholder="Search products…"
        aria-label="Search products"
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

function Table({
  title,
  note,
  head,
  shown,
  total,
  filtered,
  emptyNote,
  footnote,
  children,
}: {
  title: string
  note: string
  head: string[]
  shown: number
  total: number
  filtered?: boolean
  emptyNote?: string
  /** A caveat that belongs to THIS table rather than to the page. */
  footnote?: string
  children: React.ReactNode
}) {
  return (
    <section className="wl-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div
        className="flex items-baseline justify-between gap-3 flex-wrap"
        style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}
      >
        <h2 style={{ fontSize: '18px', fontWeight: 500, color: 'var(--ink)' }}>{title}</h2>
        <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>{note}</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--hairline)' }}>
              {head.map((h, i) => (
                <th
                  key={h}
                  style={{
                    padding: '9px 12px',
                    textAlign: i === 0 ? 'left' : 'right',
                    paddingLeft: i === 0 ? '18px' : '12px',
                    paddingRight: i === head.length - 1 ? '18px' : '12px',
                    fontSize: '11px',
                    fontWeight: 400,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--ink-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {emptyNote && (
        <p
          style={{
            fontSize: '13px',
            color: 'var(--ink-muted)',
            padding: '28px 18px',
            textAlign: 'center',
          }}
        >
          {emptyNote}
        </p>
      )}
      {total > shown && (
        <p style={{ fontSize: '11px', color: 'var(--ink-muted)', padding: '10px 18px' }}>
          Showing the {shown} largest of {total}
          {filtered ? ' matching' : ''}. The totals above cover every product, searched or not.
        </p>
      )}
      {footnote && (
        <p
          style={{
            fontSize: '11px',
            color: 'var(--ink-muted)',
            padding: '10px 18px',
            lineHeight: 1.5,
            borderTop: '1px solid var(--hairline)',
          }}
        >
          {footnote}
        </p>
      )}
    </section>
  )
}

function Td({
  children,
  left,
  strong,
  muted,
  tone,
}: {
  children: React.ReactNode
  left?: boolean
  strong?: boolean
  muted?: boolean
  tone?: 'bad'
}) {
  return (
    <td
      style={{
        padding: '9px 12px',
        paddingLeft: left ? '18px' : '12px',
        textAlign: left ? 'left' : 'right',
        whiteSpace: left ? 'normal' : 'nowrap',
        fontVariantNumeric: left ? undefined : 'tabular-nums',
        fontWeight: strong ? 500 : 400,
        color: tone === 'bad' ? 'var(--accent-red)' : muted ? 'var(--ink-muted)' : 'var(--ink)',
        maxWidth: left ? '340px' : undefined,
      }}
    >
      {children}
    </td>
  )
}
