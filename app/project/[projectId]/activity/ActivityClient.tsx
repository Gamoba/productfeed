'use client'

import { useMemo, useState } from 'react'
import type { ActivityRow } from '@/lib/activity'
import { formatNumber } from '@/lib/formatDa'
import './activity.css'

const fmt = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtDay = new Intl.DateTimeFormat('da-DK', { day: 'numeric', month: 'short', year: 'numeric' })

export function ActivityClient({ rows, available, limit }: { rows: ActivityRow[]; available: boolean; limit: number }) {
  const [where, setWhere] = useState('all')
  const [area, setArea] = useState('all')
  const [who, setWho] = useState('all')

  const opts = useMemo(() => {
    const uniq = (f: (r: ActivityRow) => string) => [...new Set(rows.map(f))].sort((a, b) => a.localeCompare(b, 'da'))
    return { where: uniq((r) => r.where), area: uniq((r) => r.area), who: uniq((r) => r.actor) }
  }, [rows])

  const shown = rows.filter(
    (r) => (where === 'all' || r.where === where) && (area === 'all' || r.area === area) && (who === 'all' || r.actor === who)
  )
  const filtered = where !== 'all' || area !== 'all' || who !== 'all'
  const span =
    rows.length > 0 ? `${fmtDay.format(new Date(rows[rows.length - 1].at))} til ${fmtDay.format(new Date(rows[0].at))}` : null

  return (
    <div className="al">
      <header className="al-head">
        <div>
          <h1>Activity log</h1>
          <p className="al-lede">Hvem har ændret hvad, og hvornår. Hver linje viser værdien før og efter.</p>
        </div>
      </header>

      {!available ? (
        <section className="card al-empty">
          <h3>Loggen er ikke slået til endnu</h3>
          <p>Den kræver databaseændringen for aktivitetsloggen (migration 056). Når den er kørt, logges ændringer herfra.</p>
        </section>
      ) : (
        <>
          <div className="al-tools">
            <Select label="Hvor" value={where} onChange={setWhere} all="Alle steder" options={opts.where} />
            <Select label="Hændelse" value={area} onChange={setArea} all="Alle hændelser" options={opts.area} />
            <Select label="Bruger" value={who} onChange={setWho} all="Alle brugere" options={opts.who} />
            <span className="al-count">
              {span && <>{span} · </>}
              {formatNumber(shown.length)} {shown.length === 1 ? 'hændelse' : 'hændelser'}
            </span>
          </div>

          <section className="card flush">
            <div className="al-tablewrap">
              <table className="al-table">
                <thead>
                  <tr>
                    <th>Tidspunkt</th>
                    <th>Bruger</th>
                    <th>Hvor</th>
                    <th>Hvad</th>
                    <th>Før</th>
                    <th>Efter</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const failed = /fejlede/i.test(r.action)
                    return (
                      <tr key={r.id}>
                        <td className="al-when num">{fmt.format(new Date(r.at))}</td>
                        <td className={r.isSystem ? 'al-muted' : undefined}>{r.actor}</td>
                        <td>{r.where}</td>
                        <td>
                          <b className="al-what">{r.action}</b>
                          <small className="al-area">{r.area}</small>
                        </td>
                        <td className="al-val al-muted">{r.before ?? '–'}</td>
                        <td className="al-val">
                          {failed && r.after ? <span className="pill bad">{r.after}</span> : (r.after ?? '–')}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {shown.length === 0 && (
              <p className="al-none">
                {rows.length === 0
                  ? 'Ingen ændringer endnu. Når nogen gemmer noget i shoppen eller dens feeds, står det her.'
                  : 'Ingen hændelser med de valg. Vælg Alle for at se hele loggen.'}
              </p>
            )}
          </section>

          <p className="al-foot">
            {rows.length >= limit && !filtered ? `Viser de seneste ${formatNumber(limit)} hændelser. ` : ''}
            Automatiske kørsler logges kun, når de fejler. Hændelser om brugere gælder hele kontoen og vises i alle shops.
          </p>
        </>
      )}
    </div>
  )
}

function Select({
  label,
  value,
  onChange,
  all,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  all: string
  options: string[]
}) {
  return (
    <select className="al-sel" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="all">{all}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}
