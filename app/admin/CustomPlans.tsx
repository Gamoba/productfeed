'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { CustomPlanRow } from '@/lib/customPlans'
import { createCustomPlanAction, newPlanLinkAction, setPlanActiveAction, type AdminResult } from './actions'

const money = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const lim = (n: number | null, unit: string) => (n === null ? `unlimited ${unit}` : `${n} ${unit}`)

const EMPTY = {
  name: '',
  note: '',
  monthlyEuros: '',
  yearlyEuros: '',
  includedSkus: '',
  feedLimit: '',
  shopLimit: '',
  userLimit: '',
  syncsPerDay: '5',
  accountId: '',
  email: '',
}

// Admin › Custom plans: plans made for one company Gamoba has an agreement
// with (lib/customPlans.ts). For an existing account it shows on their
// Billing at once; for a new company the admin gets a one-time signup link.
export function CustomPlans({ plans, accounts }: { plans: CustomPlanRow[]; accounts: { id: string; name: string }[] }) {
  const router = useRouter()
  const [, start] = useTransition()
  const [f, setF] = useState(EMPTY)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<AdminResult | null>(null)
  const [linkEmail, setLinkEmail] = useState<Record<string, string>>({})
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value })

  function run(key: string, fn: () => Promise<AdminResult>, after?: (r: AdminResult) => void) {
    setBusy(key)
    setResult(null)
    start(async () => {
      const r = await fn()
      setResult(r)
      after?.(r)
      setBusy(null)
      router.refresh()
    })
  }

  return (
    <section className="card">
      <h3 className="mc-h3">Custom plans</h3>
      <small className="ag-muted">
        For a company you&rsquo;ve agreed terms with (the Enterprise route). Set the prices and limits; leave a limit empty for
        unlimited. For a new company you get a one-time signup link (30 days).
      </small>

      {result?.error && <p className="note warn">{result.error}</p>}
      {result?.message && (
        <p className="note">
          {result.message}
          {result.link && (
            <>
              {' '}
              <span className="mc-link">{result.link}</span>{' '}
              <button type="button" className="link" onClick={() => void navigator.clipboard.writeText(result.link!)}>
                Copy
              </button>
            </>
          )}
        </p>
      )}

      <form
        className="cp-form"
        onSubmit={(e) => {
          e.preventDefault()
          run('create', () => createCustomPlanAction(f), (r) => r.ok && setF(EMPTY))
        }}
      >
        <label className="cp-wide">
          <span>Plan name</span>
          <input className="mc-input" value={f.name} onChange={set('name')} placeholder="Enterprise – Company X" required />
        </label>
        <label>
          <span>Monthly price (€, excl. VAT)</span>
          <input className="mc-input" inputMode="decimal" value={f.monthlyEuros} onChange={set('monthlyEuros')} placeholder="e.g. 450" />
        </label>
        <label>
          <span>Yearly price (€, excl. VAT)</span>
          <input className="mc-input" inputMode="decimal" value={f.yearlyEuros} onChange={set('yearlyEuros')} placeholder="e.g. 4500" />
        </label>
        <label>
          <span>Included SKUs</span>
          <input className="mc-input" inputMode="numeric" value={f.includedSkus} onChange={set('includedSkus')} placeholder="unlimited" />
        </label>
        <label>
          <span>Feeds</span>
          <input className="mc-input" inputMode="numeric" value={f.feedLimit} onChange={set('feedLimit')} placeholder="unlimited" />
        </label>
        <label>
          <span>Shops</span>
          <input className="mc-input" inputMode="numeric" value={f.shopLimit} onChange={set('shopLimit')} placeholder="unlimited" />
        </label>
        <label>
          <span>Users</span>
          <input className="mc-input" inputMode="numeric" value={f.userLimit} onChange={set('userLimit')} placeholder="unlimited" />
        </label>
        <label>
          <span>Syncs per day</span>
          <input className="mc-input" inputMode="numeric" value={f.syncsPerDay} onChange={set('syncsPerDay')} placeholder="unlimited" />
        </label>
        <label className="cp-wide">
          <span>For</span>
          <select className="mc-select" value={f.accountId} onChange={set('accountId')}>
            <option value="">A new company (one-time signup link)</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                Existing account: {a.name}
              </option>
            ))}
          </select>
        </label>
        {!f.accountId && (
          <label className="cp-wide">
            <span>Their email (optional: locks the link to it and sends it there)</span>
            <input className="mc-input" type="email" value={f.email} onChange={set('email')} placeholder="name@company.com" />
          </label>
        )}
        <label className="cp-wide">
          <span>Note (only here: what was agreed)</span>
          <input className="mc-input" value={f.note} onChange={set('note')} placeholder="e.g. 2-year deal, onboarding included" />
        </label>
        <div className="cp-wide">
          <button className="wl-btn-primary" disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : 'Create custom plan'}
          </button>
        </div>
      </form>

      {plans.length > 0 && (
        <table className="ag-table">
          <thead>
            <tr>
              <th>Plan</th>
              <th>Price</th>
              <th>Limits</th>
              <th>For</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id} className={p.active ? undefined : 'cp-retired'}>
                <td>
                  <b>{p.name}</b>
                  {!p.active && <div className="mc-bad">Retired</div>}
                  {p.note && <div className="ag-muted">{p.note}</div>}
                </td>
                <td>
                  {p.prices.map((x) => (
                    <div key={x.interval}>
                      {money(x.amountCents)} / {x.interval}
                    </div>
                  ))}
                </td>
                <td className="ag-muted">
                  {lim(p.limits.feeds, 'feeds')} · {lim(p.limits.shops, 'shops')} · {lim(p.limits.users, 'users')}
                  <br />
                  {lim(p.limits.syncsPerDay, 'syncs/day')} · {p.limits.includedSkus === null ? 'unlimited SKUs' : `${p.limits.includedSkus} SKUs`}
                </td>
                <td>
                  {p.account ? (
                    <>
                      <b>{p.account.name}</b>
                      <div className={p.subscribed ? 'st' : 'ag-muted'}>{p.subscribed ? 'Subscribed' : 'Not subscribed yet'}</div>
                    </>
                  ) : p.link && !p.link.expired ? (
                    <span className="ag-muted">
                      Link not used yet{p.link.email ? ` (${p.link.email})` : ''} · until {when(p.link.expiresAt)}
                    </span>
                  ) : (
                    <span className="mc-bad">Link expired</span>
                  )}
                </td>
                <td className="r">
                  <div className="mc-row mc-right">
                    {!p.account && p.active && (
                      <>
                        <input
                          className="mc-input"
                          style={{ minWidth: 160 }}
                          type="email"
                          placeholder="email (optional)"
                          aria-label={`Email for a new ${p.name} link`}
                          value={linkEmail[p.id] ?? ''}
                          onChange={(e) => setLinkEmail({ ...linkEmail, [p.id]: e.target.value })}
                        />
                        <button type="button" className="wl-btn-secondary" disabled={busy !== null} onClick={() => run(p.id, () => newPlanLinkAction(p.id, linkEmail[p.id] ?? ''))}>
                          New link
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="wl-btn-secondary"
                      disabled={busy !== null}
                      onClick={() => run(p.id, () => setPlanActiveAction(p.id, !p.active))}
                      title={p.active ? 'No new subscriptions; existing ones keep running' : undefined}
                    >
                      {p.active ? 'Retire' : 'Offer again'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
