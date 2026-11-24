'use client'

import { useMemo, useState } from 'react'
import type { ActivityRow } from '@/lib/activity'
import { formatNumber } from '@/lib/formatDa'
import './activity.css'

const fmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const fmtDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export function ActivityClient({ rows, available, limit }: { rows: ActivityRow[]; available: boolean; limit: number }) {
  const [where, setWhere] = useState('all')
  const [area, setArea] = useState('all')
  const [who, setWho] = useState('all')

  const opts = useMemo(() => {
    const uniq = (f: (r: ActivityRow) => string) => [...new Set(rows.map(f))].sort((a, b) => a.localeCompare(b, 'en'))
    return { where: uniq((r) => r.where), area: uniq((r) => r.area), who: uniq((r) => r.actor) }
  }, [rows])

  const shown = rows.filter(
    (r) => (where === 'all' || r.where === where) && (area === 'all' || r.area === area) && (who === 'all' || r.actor === who)
  )
  const filtered = where !== 'all' || area !== 'all' || who !== 'all'
  const span =
    rows.length > 0 ? `${fmtDay.format(new Date(rows[rows.length - 1].at))} to ${fmtDay.format(new Date(rows[0].at))}` : null

  return (
    <div className="al">
      <header className="al-head">
        <div>
          <h1>Activity log</h1>
          <p className="al-lede">Who changed what, and when. Each line shows the value before and after.</p>
        </div>
      </header>

      {!available ? (
        <section className="card al-empty">
          <h3>The log is not switched on yet</h3>
          <p>It needs the activity log database change (migration 056). Once that has run, changes are logged from then on.</p>
        </section>
      ) : (
        <>
          <div className="al-tools">
            <Select label="Where" value={where} onChange={setWhere} all="All places" options={opts.where} />
            <Select label="Event" value={area} onChange={setArea} all="All events" options={opts.area} />
            <Select label="User" value={who} onChange={setWho} all="All users" options={opts.who} />
            <span className="al-count">
              {span && <>{span} · </>}
              {formatNumber(shown.length)} {shown.length === 1 ? 'event' : 'events'}
            </span>
          </div>

          <section className="card flush">
            <div className="al-tablewrap">
              <table className="al-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>User</th>
                    <th>Where</th>
                    <th>What</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const failed = /fejlede|failed/i.test(r.action)
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
                  ? 'No changes yet. When someone saves something in the shop or its feeds, it shows up here.'
                  : 'No events match those filters. Choose All to see the whole log.'}
              </p>
            )}
          </section>

          <p className="al-foot">
            {rows.length >= limit && !filtered ? `Showing the latest ${formatNumber(limit)} events. ` : ''}
            Automatic runs are only logged when they fail. Events about users apply to the whole account and show in every shop.
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
