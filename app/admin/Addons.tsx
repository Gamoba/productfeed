'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AdminAddons } from '@/lib/addons'
import { createAddonAction, grantAddonAction, revokeFreeAddonAction, setAddonActiveAction, type AdminResult } from './actions'

const money = (cents: number) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)

const EMPTY = {
  name: '',
  description: '',
  monthlyEuros: '',
  yearlyEuros: '',
  feedDelta: '',
  shopDelta: '',
  userDelta: '',
  skuDelta: '',
  quantityEnabled: false,
  maxQuantity: '',
  selfServe: true,
}

const GRANT = { accountId: '', addonId: '', quantity: '1', free: false, note: '' }

function raises(a: { feedDelta: number; shopDelta: number; userDelta: number; skuDelta: number }): string {
  const parts = [
    a.feedDelta ? `+${a.feedDelta} feeds` : '',
    a.shopDelta ? `+${a.shopDelta} shops` : '',
    a.userDelta ? `+${a.userDelta} users` : '',
    a.skuDelta ? `+${a.skuDelta.toLocaleString('en-GB')} SKUs` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'no extra limits'
}

// Admin › Add-ons: the catalogue customers can buy from Billing, and putting
// one on an account by hand (lib/addons.ts). Prices and limits live in the
// database, so changing them needs no release.
export function Addons({ data }: { data: AdminAddons }) {
  const router = useRouter()
  const [, start] = useTransition()
  const [f, setF] = useState(EMPTY)
  const [g, setG] = useState(GRANT)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<AdminResult | null>(null)

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value })
  const setGrant = (k: keyof typeof GRANT) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setG({ ...g, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value })

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

  const grantsOf = (addonId: string) => data.grants.filter((x) => x.addonId === addonId)

  return (
    <section className="card">
      <h3 className="mc-h3">Add-ons</h3>
      <small className="ag-muted">
        Extras a customer can put on its plan: a managed service, coaching, a pack of extra feeds. An add-on is billed with the
        plan, at the same interval, and can raise the plan&rsquo;s limits. Set a price for both intervals so monthly and yearly
        customers can both buy it.
      </small>

      {result?.error && <p className="note warn">{result.error}</p>}
      {result?.message && <p className="note">{result.message}</p>}

      <form
        className="cp-form"
        onSubmit={(e) => {
          e.preventDefault()
          run('create', () => createAddonAction(f), (r) => r.ok && setF(EMPTY))
        }}
      >
        <label className="cp-wide">
          <span>Name</span>
          <input className="mc-input" value={f.name} onChange={set('name')} placeholder="5 extra feeds" required />
        </label>
        <label className="cp-wide">
          <span>Description (shown on Billing)</span>
          <input
            className="mc-input"
            value={f.description}
            onChange={set('description')}
            placeholder="Five more feeds on top of your plan."
          />
        </label>
        <label>
          <span>Monthly price (€, excl. VAT)</span>
          <input className="mc-input" inputMode="decimal" value={f.monthlyEuros} onChange={set('monthlyEuros')} placeholder="e.g. 15" />
        </label>
        <label>
          <span>Yearly price (€, excl. VAT)</span>
          <input className="mc-input" inputMode="decimal" value={f.yearlyEuros} onChange={set('yearlyEuros')} placeholder="e.g. 150" />
        </label>
        <label>
          <span>Extra feeds (per unit)</span>
          <input className="mc-input" inputMode="numeric" value={f.feedDelta} onChange={set('feedDelta')} placeholder="0" />
        </label>
        <label>
          <span>Extra shops</span>
          <input className="mc-input" inputMode="numeric" value={f.shopDelta} onChange={set('shopDelta')} placeholder="0" />
        </label>
        <label>
          <span>Extra users</span>
          <input className="mc-input" inputMode="numeric" value={f.userDelta} onChange={set('userDelta')} placeholder="0" />
        </label>
        <label>
          <span>Extra included SKUs</span>
          <input className="mc-input" inputMode="numeric" value={f.skuDelta} onChange={set('skuDelta')} placeholder="0" />
        </label>
        <label className="ad-check">
          <input type="checkbox" checked={f.quantityEnabled} onChange={set('quantityEnabled')} />
          <span>The customer chooses how many (a pack)</span>
        </label>
        {f.quantityEnabled && (
          <label>
            <span>Highest quantity</span>
            <input className="mc-input" inputMode="numeric" value={f.maxQuantity} onChange={set('maxQuantity')} placeholder="no limit" />
          </label>
        )}
        <label className="ad-check">
          <input type="checkbox" checked={f.selfServe} onChange={set('selfServe')} />
          <span>Customers can buy it themselves on Billing</span>
        </label>
        <div className="cp-wide">
          <button className="wl-btn-primary" disabled={busy !== null}>
            {busy === 'create' ? 'Creating…' : 'Create add-on'}
          </button>
        </div>
      </form>

      {data.addons.length > 0 && (
        <table className="ag-table">
          <thead>
            <tr>
              <th>Add-on</th>
              <th>Price</th>
              <th>Raises</th>
              <th>On accounts</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.addons.map((a) => (
              <tr key={a.id} className={a.active ? undefined : 'cp-retired'}>
                <td>
                  <b>{a.name}</b>
                  {!a.active && <div className="mc-bad">Retired</div>}
                  {a.description && <div className="ag-muted">{a.description}</div>}
                  {!a.selfServe && <div className="ag-muted">By us only</div>}
                  {a.quantityEnabled && (
                    <div className="ag-muted">Pack{a.maxQuantity === null ? '' : `, up to ${a.maxQuantity}`}</div>
                  )}
                </td>
                <td>
                  {a.prices.length === 0 && <span className="mc-bad">No price</span>}
                  {a.prices.map((p) => (
                    <div key={p.interval}>
                      {money(p.amountCents)} / {p.interval}
                    </div>
                  ))}
                </td>
                <td className="ag-muted">{raises(a)}</td>
                <td>
                  {grantsOf(a.id).length === 0 ? (
                    <span className="ag-muted">nobody yet</span>
                  ) : (
                    grantsOf(a.id).map((x) => (
                      <div key={x.id} className="mc-row">
                        <span>
                          {x.accountName}
                          {x.quantity > 1 ? ` × ${x.quantity}` : ''}
                          {x.free && <span className="pill ai"> Free</span>}
                        </span>
                        {x.free && (
                          <button
                            type="button"
                            className="link"
                            disabled={busy !== null}
                            onClick={() => run(x.id, () => revokeFreeAddonAction(x.id))}
                          >
                            Take off
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </td>
                <td className="r">
                  <button
                    type="button"
                    className="wl-btn-secondary"
                    disabled={busy !== null}
                    onClick={() => run(a.id, () => setAddonActiveAction(a.id, !a.active))}
                    title={a.active ? 'No new purchases; accounts that have it keep it' : undefined}
                  >
                    {a.active ? 'Retire' : 'Offer again'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.addons.length > 0 && (
        <form
          className="cp-form ad-grant"
          onSubmit={(e) => {
            e.preventDefault()
            run('grant', () => grantAddonAction(g.accountId, g.addonId, g.quantity, g.free, g.note), (r) => r.ok && setG(GRANT))
          }}
        >
          <h4 className="mc-h4">Put an add-on on an account</h4>
          <small className="ag-muted cp-wide">
            Billed adds it to their subscription, so Stripe charges the rest of the period. Free raises their limits and charges
            nothing — for an add-on thrown in on a deal.
          </small>
          <label>
            <span>Account</span>
            <select className="mc-select" value={g.accountId} onChange={setGrant('accountId')} required>
              <option value="">Choose…</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Add-on</span>
            <select className="mc-select" value={g.addonId} onChange={setGrant('addonId')} required>
              <option value="">Choose…</option>
              {data.addons.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>How many</span>
            <input className="mc-input" inputMode="numeric" value={g.quantity} onChange={setGrant('quantity')} />
          </label>
          <label className="ad-check">
            <input type="checkbox" checked={g.free} onChange={setGrant('free')} />
            <span>Free (nothing billed)</span>
          </label>
          <label className="cp-wide">
            <span>Note (only here: what was agreed)</span>
            <input className="mc-input" value={g.note} onChange={setGrant('note')} placeholder="e.g. included in the onboarding deal" />
          </label>
          <div className="cp-wide">
            <button className="wl-btn-primary" disabled={busy !== null}>
              {busy === 'grant' ? 'Adding…' : 'Add to the account'}
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
