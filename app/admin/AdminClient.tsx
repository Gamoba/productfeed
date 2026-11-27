'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AdminOverview } from '@/lib/mcc'
import type { PayoutDue } from '@/lib/commissions'
import type { CustomPlanRow } from '@/lib/customPlans'
import { CustomPlans } from './CustomPlans'
import { Addons } from './Addons'
import type { AdminAddons } from '@/lib/addons'
import {
  inviteMccAction,
  markPaidAction,
  setAgencyRateAction,
  setDefaultRateAction,
  setOverrideAction,
  type AdminResult,
} from './actions'
import '../agency/agency.css'
import '../agency/mcc.css'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)
const pct = (r: number | null) => (r === null ? '' : String(Math.round(r * 1000) / 10))

export function AdminClient({
  overview,
  defaultRate,
  due,
  emailReady,
  custom,
  addons,
}: {
  overview: AdminOverview
  defaultRate: number | null
  due: PayoutDue[]
  emailReady: boolean
  custom: { plans: CustomPlanRow[]; accounts: { id: string; name: string }[] }
  addons: AdminAddons
}) {
  const router = useRouter()
  const [, start] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<AdminResult | null>(null)
  const [rate, setRate] = useState(pct(defaultRate))
  const [inv, setInv] = useState({ email: '', name: '' })
  const [rates, setRates] = useState<Record<string, string>>(Object.fromEntries(overview.agencies.map((a) => [a.id, pct(a.rate)])))
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>(Object.fromEntries(overview.referrals.map((r) => [r.id, r.note ?? ''])))

  function run(key: string, fn: () => Promise<AdminResult>) {
    setBusy(key)
    setResult(null)
    start(async () => {
      const r = await fn()
      setResult(r)
      setBusy(null)
      router.refresh()
    })
  }

  return (
    <div className="ag">
      <div className="ag-head">
        <div>
          <h1>Admin</h1>
          <p className="ag-lede">
            Agencies, custom plans, add-ons, commission and payouts. Only Gamoba staff see this page.
          </p>
        </div>
      </div>

      {result?.error && <p className="note warn">{result.error}</p>}
      {result?.message && (
        <p className="note">
          {result.message}
          {result.link && <span className="mc-link"> {result.link}</span>}
        </p>
      )}

      <section className="card">
        <h3 className="mc-h3">Default commission</h3>
        <small className="ag-muted">The share of each paid invoice (excl. VAT) an agency earns on a client it referred, unless the agency has its own rate. Each referral keeps the rate it signed up at.</small>
        <form
          className="mc-form"
          onSubmit={(e) => {
            e.preventDefault()
            run('rate', () => setDefaultRateAction(rate))
          }}
        >
          <input className="mc-input" style={{ minWidth: 90, width: 90 }} value={rate} onChange={(e) => setRate(e.target.value)} placeholder="20" aria-label="Default commission in percent" />
          <span>%</span>
          <button className="wl-btn-primary" disabled={busy !== null}>
            Save
          </button>
          {defaultRate === null && <span className="mc-bad">Not set: referrals record 0 %.</span>}
        </form>
      </section>

      <section className="card">
        <h3 className="mc-h3">Invite an agency</h3>
        <small className="ag-muted">
          They get an email to set up the agency account (one-time link, 7 days).
          {!emailReady && ' App email isn’t set up, so for someone who already has a login you get a link to send yourself.'}
        </small>
        <form
          className="mc-form"
          onSubmit={(e) => {
            e.preventDefault()
            run('invite', async () => {
              const r = await inviteMccAction(inv.email, inv.name)
              if (r.ok) setInv({ email: '', name: '' })
              return r
            })
          }}
        >
          <input className="mc-input" value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} placeholder="Agency name" aria-label="Agency name" required />
          <input className="mc-input" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} placeholder="Email" aria-label="Email" required />
          <button className="wl-btn-primary" disabled={busy !== null}>
            {busy === 'invite' ? 'Sending…' : 'Send invitation'}
          </button>
        </form>
        {overview.invites.length > 0 && (
          <table className="ag-table">
            <tbody>
              {overview.invites.slice(0, 10).map((i) => (
                <tr key={i.id}>
                  <td>
                    <b>{i.name ?? '—'}</b>
                    <div className="ag-muted">{i.email}</div>
                  </td>
                  <td>{i.usedAt ? <span className="st">Accepted {when(i.usedAt)}</span> : new Date(i.expiresAt) < new Date() ? <span className="mc-bad">Expired</span> : <span className="ag-muted">Sent {when(i.createdAt)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <CustomPlans plans={custom.plans} accounts={custom.accounts} />

      <Addons data={addons} />

      <section className="card flush">
        <div className="mc-cardhead">
          <h3>Payouts due</h3>
          <small>What each agency is owed today. Pay them, then mark it here with a reference.</small>
        </div>
        {due.length === 0 ? (
          <div className="ag-empty">
            <p>Nothing is due.</p>
          </div>
        ) : (
          <table className="ag-table">
            <tbody>
              {due.map((d) => {
                const key = `${d.mccAccountId}:${d.currency}`
                return (
                  <tr key={key}>
                    <td>
                      <b>{d.mccName}</b>
                      <div className="ag-muted">{d.parts} part(s)</div>
                    </td>
                    <td className="r">{money(d.dueCents, d.currency)}</td>
                    <td className="r">
                      <div className="mc-row mc-right">
                        <input className="mc-input" value={refs[key] ?? ''} onChange={(e) => setRefs({ ...refs, [key]: e.target.value })} placeholder="Reference" aria-label="Payment reference" />
                        <button
                          type="button"
                          className="wl-btn-primary"
                          disabled={busy !== null}
                          onClick={() => {
                            if (confirm(`Mark ${money(d.dueCents, d.currency)} to ${d.mccName} as paid?`)) run(key, () => markPaidAction(d.mccAccountId, d.currency, refs[key] ?? ''))
                          }}
                        >
                          Mark as paid
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card flush">
        <div className="mc-cardhead">
          <h3>Agencies</h3>
          <small>Leave the rate empty to use the default.</small>
        </div>
        {overview.agencies.length === 0 ? (
          <div className="ag-empty">
            <p>No agencies yet.</p>
          </div>
        ) : (
          <table className="ag-table">
            <thead>
              <tr>
                <th>Agency</th>
                <th className="r">Clients</th>
                <th className="r">Referrals</th>
                <th>Referral code</th>
                <th className="r">Rate</th>
              </tr>
            </thead>
            <tbody>
              {overview.agencies.map((a) => (
                <tr key={a.id}>
                  <td>
                    <b>{a.name}</b>
                  </td>
                  <td className="r">{a.clients}</td>
                  <td className="r">{a.referrals}</td>
                  <td className="ag-muted">{a.code ?? '—'}</td>
                  <td className="r">
                    <div className="mc-row mc-right">
                      <input className="mc-input" style={{ width: 70, minWidth: 70 }} value={rates[a.id] ?? ''} onChange={(e) => setRates({ ...rates, [a.id]: e.target.value })} placeholder="default" aria-label={`${a.name} rate in percent`} />
                      <span>%</span>
                      <button type="button" className="wl-btn-secondary" disabled={busy !== null} onClick={() => run(a.id, () => setAgencyRateAction(a.id, rates[a.id] ?? ''))}>
                        Save
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card flush">
        <div className="mc-cardhead">
          <h3>Referrals</h3>
          <small>A kickback stops when the client removes the agency&rsquo;s access. Switch it back on here, depending on the deal with the agency.</small>
        </div>
        {overview.referrals.length === 0 ? (
          <div className="ag-empty">
            <p>No referrals yet.</p>
          </div>
        ) : (
          <table className="ag-table">
            <thead>
              <tr>
                <th>Agency → client</th>
                <th>Status</th>
                <th className="r">Rate</th>
                <th>Kickback despite removed access</th>
              </tr>
            </thead>
            <tbody>
              {overview.referrals.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.agency}</b> → {r.client}
                  </td>
                  <td className={r.status === 'stopped' ? 'mc-bad' : undefined}>
                    {r.status === 'stopped' ? 'Stopped (access removed)' : r.status === 'active' ? 'Earning' : 'Not paid yet'}
                  </td>
                  <td className="r">{pct(r.rate)} %</td>
                  <td>
                    <div className="mc-row">
                      <input className="mc-input" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} placeholder="Note on the deal" aria-label="Note" />
                      <button
                        type="button"
                        className={r.override ? 'wl-btn-primary' : 'wl-btn-secondary'}
                        disabled={busy !== null}
                        onClick={() => run(r.id, () => setOverrideAction(r.id, !r.override, notes[r.id] ?? ''))}
                      >
                        {r.override ? 'On · switch off' : 'Switch on'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
