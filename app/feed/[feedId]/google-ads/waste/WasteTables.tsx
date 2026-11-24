'use client'

import { useMemo, useState } from 'react'
import { formatInt, formatMoney, formatPercent } from '@/lib/googleAdsAnalytics'
import { Icon } from '@/app/components/shell/icons'

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
        const hay = [r.title, r.productRef, r.handle, r.vendor, r.productType].filter(Boolean).join(' ').toLowerCase()
        return terms.every((t) => hay.includes(t))
      })
    }
  }, [query])

  const wastedShown = filter(wasted)
  const losingShown = filter(losing)
  const unavailableShown = filter(unavailable)
  const searching = query.trim().length > 0
  const q = query.trim()

  return (
    <>
      {(wasted.length > 0 || losing.length > 0 || unavailable.length > 0) && (
        <label className="ws-search">
          <Icon name="search" size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Search the lists by title, vendor or ID"
            aria-label="Search products"
          />
        </label>
      )}

      {/* Spending on something nobody can buy today */}
      {unavailable.length > 0 && (
        <Table
          title="Spend on out-of-stock products"
          note={`Out of stock now · ${formatMoney(unavailableCost, currency)} spent in the last ${days} days`}
          head={['Product', 'Variants in stock', 'Clicks', 'Spend']}
          shown={Math.min(unavailableShown.length, ROW_LIMIT)}
          total={unavailableShown.length}
          filtered={searching}
          emptyNote={
            searching && unavailableShown.length === 0
              ? `No product here matches «${q}». ${unavailable.length} ${unavailable.length === 1 ? 'is' : 'are'} out of stock.`
              : undefined
          }
          // The caveat that decides whether this table can be acted on at all:
          // it pairs a window of spend with stock as of one moment.
          footnote={
            stockSyncedAt
              ? `Stock is from ${new Date(stockSyncedAt).toLocaleString('en-GB')}` +
                (stockAgeDays !== null && stockAgeDays > 0
                  ? `, ${stockAgeDays} ${stockAgeDays === 1 ? 'day' : 'days'} ago`
                  : '') +
                `. Spend covers the whole ${days}-day period, so most of it was probably spent while the product was in stock. The list shows budget going to something that cannot be shipped today, not money already lost.`
              : undefined
          }
        >
          {unavailableShown.slice(0, ROW_LIMIT).map((r) => (
            <tr key={r.productRef}>
              <Name r={r} />
              <td className="r ws-muted num">{r.variantsTotal > 0 ? `0 of ${r.variantsTotal}` : '—'}</td>
              <td className="r num">{formatInt(r.clicks)}</td>
              <td className="r num neg">{formatMoney(r.cost, currency)}</td>
            </tr>
          ))}
        </Table>
      )}

      {/* Converting, and still underwater */}
      {showLosing && losing.length > 0 && (
        <Table
          title="Selling, but at a loss"
          note={`Gross profit below ad spend · ${formatMoney(losingCost, currency)} in total`}
          head={['Product', 'Spend', 'Gross profit', 'Profit − spend']}
          shown={Math.min(losingShown.length, ROW_LIMIT)}
          total={losingShown.length}
          filtered={searching}
          emptyNote={
            searching && losingShown.length === 0 ? `No product here matches «${q}». ${losing.length} ${losing.length === 1 ? 'sells' : 'sell'} at a loss.` : undefined
          }
        >
          {losingShown.slice(0, ROW_LIMIT).map((r) => (
            <tr key={r.productRef}>
              <Name r={r} />
              <td className="r num">{formatMoney(r.cost, currency)}</td>
              <td className="r num">{formatMoney(r.poasValue, currency)}</td>
              <td className="r num neg">{formatMoney(r.profitAfterAdSpend, currency)}</td>
            </tr>
          ))}
        </Table>
      )}

      {/* Spend with nothing to show */}
      {wasted.length === 0 ? (
        wastedEmpty
      ) : (
        <Table
          title="Spend without revenue"
          note={`${days} days · sorted by spend`}
          head={['Product', 'Impressions', 'Clicks', 'Spend', 'Share']}
          shown={Math.min(wastedShown.length, ROW_LIMIT)}
          total={wastedShown.length}
          filtered={searching}
          emptyNote={
            searching && wastedShown.length === 0
              ? `No product here matches «${q}». ${wasted.length} ${wasted.length === 1 ? 'product has' : 'products have'} spent budget without revenue.`
              : undefined
          }
        >
          {wastedShown.slice(0, ROW_LIMIT).map((r) => (
            <tr key={r.productRef}>
              <Name r={r} />
              <td className="r num">{formatInt(r.impressions)}</td>
              <td className="r num">{formatInt(r.clicks)}</td>
              <td className="r num ws-strong">{formatMoney(r.cost, currency)}</td>
              <td className="r num ws-muted">{wastedCost > 0 ? formatPercent(r.cost / wastedCost, 0) : '—'}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  )
}

function Name({ r }: { r: WasteRow }) {
  return (
    <td>
      <span className="ws-name">
        <b>{r.title ?? r.productRef}</b>
        <small>{[r.vendor, r.productRef].filter(Boolean).join(' · ')}</small>
      </span>
    </td>
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
    <section className="card flush">
      <div className="ws-card-h">
        <h3>{title}</h3>
        <small>{note}</small>
      </div>
      <div className="ws-tablewrap">
        <table className="ws-table">
          <thead>
            <tr>
              {head.map((h, i) => (
                <th key={h} className={i === 0 ? undefined : 'r'}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {emptyNote && <p className="ws-none">{emptyNote}</p>}
      {total > shown && (
        <p className="ws-foot">
          Showing the {shown} largest of {total}
          {filtered ? ' matching' : ''}. The figures at the top cover all products.
        </p>
      )}
      {footnote && <p className="ws-foot ws-foot-line">{footnote}</p>}
    </section>
  )
}
