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
            placeholder="Søg i listerne på titel, producent eller id"
            aria-label="Søg varer"
          />
        </label>
      )}

      {/* Spending on something nobody can buy today */}
      {unavailable.length > 0 && (
        <Table
          title="Forbrug på udsolgte varer"
          note={`Udsolgt nu · ${formatMoney(unavailableCost, currency)} brugt de sidste ${days} dage`}
          head={['Vare', 'Varianter på lager', 'Klik', 'Forbrug']}
          shown={Math.min(unavailableShown.length, ROW_LIMIT)}
          total={unavailableShown.length}
          filtered={searching}
          emptyNote={
            searching && unavailableShown.length === 0
              ? `Ingen vare her matcher «${q}». ${unavailable.length} er udsolgt.`
              : undefined
          }
          // The caveat that decides whether this table can be acted on at all:
          // it pairs a window of spend with stock as of one moment.
          footnote={
            stockSyncedAt
              ? `Lageret er fra ${new Date(stockSyncedAt).toLocaleString('da-DK')}` +
                (stockAgeDays !== null && stockAgeDays > 0
                  ? `, ${stockAgeDays} ${stockAgeDays === 1 ? 'dag' : 'dage'} siden`
                  : '') +
                `. Forbruget er for hele perioden på ${days} dage, så det meste blev nok brugt, mens varen var på lager. Listen viser budget, der går til noget, der ikke kan sendes i dag, ikke penge der allerede er tabt.`
              : undefined
          }
        >
          {unavailableShown.slice(0, ROW_LIMIT).map((r) => (
            <tr key={r.productRef}>
              <Name r={r} />
              <td className="r ws-muted num">{r.variantsTotal > 0 ? `0 af ${r.variantsTotal}` : '—'}</td>
              <td className="r num">{formatInt(r.clicks)}</td>
              <td className="r num neg">{formatMoney(r.cost, currency)}</td>
            </tr>
          ))}
        </Table>
      )}

      {/* Converting, and still underwater */}
      {showLosing && losing.length > 0 && (
        <Table
          title="Sælger, men med tab"
          note={`Bruttoprofit under annonceforbruget · ${formatMoney(losingCost, currency)} i alt`}
          head={['Vare', 'Forbrug', 'Bruttoprofit', 'Profit − forbrug']}
          shown={Math.min(losingShown.length, ROW_LIMIT)}
          total={losingShown.length}
          filtered={searching}
          emptyNote={
            searching && losingShown.length === 0 ? `Ingen vare her matcher «${q}». ${losing.length} sælger med tab.` : undefined
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
          title="Forbrug uden omsætning"
          note={`${days} dage · sorteret efter forbrug`}
          head={['Vare', 'Visninger', 'Klik', 'Forbrug', 'Andel']}
          shown={Math.min(wastedShown.length, ROW_LIMIT)}
          total={wastedShown.length}
          filtered={searching}
          emptyNote={
            searching && wastedShown.length === 0
              ? `Ingen vare her matcher «${q}». ${wasted.length} varer har brugt budget uden omsætning.`
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
          Viser de {shown} største af {total}
          {filtered ? ' der matcher' : ''}. Tallene øverst dækker alle varer.
        </p>
      )}
      {footnote && <p className="ws-foot ws-foot-line">{footnote}</p>}
    </section>
  )
}
