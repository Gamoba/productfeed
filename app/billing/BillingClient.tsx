'use client'

import { useState, useTransition } from 'react'
import type { AccountBilling, Interval, Plan } from '@/lib/billing'
import { openPortal, startCheckout } from './actions'
import '../agency/agency.css'
import './billing.css'

type Props = {
  billing: AccountBilling
  plans: Plan[]
  canManage: boolean
  configured: boolean
  accounts: { id: string; name: string }[]
  checkoutNote: 'done' | 'pending' | null
}

// Where Enterprise enquiries go (brief D6). The button is hidden until it's set.
const contactEmail = process.env.NEXT_PUBLIC_SALES_EMAIL ?? ''

const num = new Intl.NumberFormat('en-GB')
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}
const date = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

function limit(n: number | null, one: string, many: string): string {
  if (n === null) return `Unlimited ${many}`
  return `${num.format(n)} ${n === 1 ? one : many}`
}

export function BillingClient({ billing, plans, canManage, configured, accounts, checkoutNote }: Props) {
  const [interval, setInterval] = useState<Interval>('month')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const { account, subscription, previous } = billing
  const current = subscription ? plans.find((p) => p.id === subscription.planId) ?? null : null
  const lapsed = !account.billingExempt && !subscription && previous ? previous : null
  const lapsedPlan = lapsed ? plans.find((p) => p.id === lapsed.planId) ?? null : null

  function go(key: string, run: () => Promise<{ url?: string; error?: string }>) {
    setBusy(key)
    setError(null)
    startTransition(async () => {
      const r = await run()
      if (r.url) {
        window.location.assign(r.url)
        return
      }
      setError(r.error ?? 'Something went wrong. Try again.')
      setBusy(null)
    })
  }

  const manageButton = canManage && configured && (subscription || lapsed) ? (
    <button
      type="button"
      className="wl-btn-primary"
      disabled={busy !== null}
      onClick={() => go('portal', () => openPortal(account.id))}
    >
      {busy === 'portal' ? 'Opening…' : 'Manage billing'}
    </button>
  ) : null

  return (
    <div className="ag">
      <div className="ag-head">
        <div>
          <h1>Billing</h1>
          <p className="ag-lede">
            The plan and payments for {account.name}. Payments, invoices and your card are handled securely by Stripe.
          </p>
        </div>
        <div className="bl-actions">
          {accounts.length > 1 && (
            <select
              className="bl-select"
              aria-label="Account"
              value={account.id}
              onChange={(e) => window.location.assign(`/billing?account=${e.target.value}`)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          {manageButton}
        </div>
      </div>

      {checkoutNote === 'done' && <p className="note">Payment received. Your plan is active.</p>}
      {checkoutNote === 'pending' && (
        <p className="note">Payment received. Your plan is being activated; refresh in a moment if it doesn&rsquo;t show.</p>
      )}
      {error && <p className="note warn">{error}</p>}
      {!configured && !account.billingExempt && (
        <p className="note warn">Billing isn&rsquo;t set up yet, so plans can&rsquo;t be bought right now.</p>
      )}

      {account.billingExempt ? (
        <section className="card tint bl-current">
          <div className="bl-current-head">
            <h3>Free account</h3>
            <span className="st">Active</span>
          </div>
          <p className="bl-sub">This account doesn&rsquo;t need a plan. Nothing will be charged.</p>
        </section>
      ) : subscription ? (
        <section className="card tint bl-current">
          <div className="bl-current-head">
            <h3>{current?.name ?? subscription.planId} plan</h3>
            {subscription.status === 'past_due' ? (
              <span className="bl-bad">Payment failed</span>
            ) : (
              <span className="st">Active</span>
            )}
          </div>
          <p className="bl-sub">
            Billed {subscription.interval === 'year' ? 'yearly' : 'monthly'}
            {current && (() => {
              const p = current.prices.find((x) => x.interval === subscription.interval)
              return p ? ` · ${money(p.amountCents, p.currency)} excl. VAT` : ''
            })()}
            {subscription.cancelAt
              ? ` · ends ${date(subscription.cancelAt)}`
              : subscription.currentPeriodEnd && ` · renews ${date(subscription.currentPeriodEnd)}`}
          </p>
          {subscription.status === 'past_due' && (
            <p className="note warn">Stripe couldn&rsquo;t take the last payment. Update your card under Manage billing.</p>
          )}
          {current && <PlanLimits plan={current} />}
          {!canManage && <p className="bl-sub">Owners and admins can change the plan.</p>}
        </section>
      ) : (
        <>
          {lapsed && (
            <section className="card bl-current bl-lapsed">
              <div className="bl-current-head">
                <h3>{lapsedPlan?.name ?? lapsed.planId} plan</h3>
                <span className="bl-bad">{lapsed.status === 'unpaid' ? 'Unpaid' : 'Ended'}</span>
              </div>
              <p className="bl-sub">
                {lapsed.status === 'unpaid'
                  ? 'The last payment didn’t go through, so the account is paused.'
                  : 'The plan has ended, so the account is paused.'}{' '}
                Your shops, feeds and settings are kept. Feeds aren’t served to Merchant Center until the plan is active again.
              </p>
              {canManage ? (
                <div className="bl-row">
                  {(() => {
                    const p = lapsedPlan?.prices.find((x) => x.interval === lapsed.interval)
                    const ok = configured && lapsedPlan?.selfServe && p?.stripePriceId
                    return (
                      <button
                        type="button"
                        className="wl-btn-primary"
                        disabled={!ok || busy !== null}
                        onClick={() => go('reactivate', () => startCheckout(account.id, lapsed.planId, lapsed.interval))}
                      >
                        {busy === 'reactivate'
                          ? 'Opening checkout…'
                          : `Reactivate ${lapsedPlan?.name ?? ''}${p ? ` · ${money(p.amountCents, p.currency)} / ${lapsed.interval}` : ''}`}
                      </button>
                    )
                  })()}
                </div>
              ) : (
                <p className="bl-sub">Ask an owner or admin to reactivate the plan.</p>
              )}
            </section>
          )}
          {lapsed && <h2 className="bl-h2">Or choose another plan</h2>}
          <div className="bl-toolbar">
            <div className="bl-seg" role="radiogroup" aria-label="Billing period">
              {(['month', 'year'] as const).map((i) => (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={interval === i}
                  className={interval === i ? 'on' : ''}
                  onClick={() => setInterval(i)}
                >
                  {i === 'month' ? 'Monthly' : 'Yearly'}
                </button>
              ))}
            </div>
            <span className="bl-sub">Yearly: pay for 10 months, get 12. All prices excl. VAT.</span>
          </div>

          <div className="bl-plans">
            {plans.filter((p) => p.active).map((plan) => {
              const price = plan.prices.find((p) => p.interval === interval)
              const other = plan.prices.find((p) => p.interval !== interval)
              if (!plan.selfServe) {
                return (
                  <section key={plan.id} className="card bl-plan">
                    <h3>{plan.name}</h3>
                    <p className="bl-price">Custom quote</p>
                    <p className="bl-sub">For large catalogues and agencies with many shops.</p>
                    <PlanLimits plan={plan} />
                    {contactEmail && (
                      <a
                        className="wl-btn-secondary bl-cta"
                        href={`mailto:${contactEmail}?subject=${encodeURIComponent('FeedFlow Enterprise')}`}
                      >
                        Contact us
                      </a>
                    )}
                  </section>
                )
              }
              return (
                <section key={plan.id} className="card bl-plan">
                  <h3>
                    {plan.name}
                    {plan.isCustom && <span className="pill ai">Made for you</span>}
                  </h3>
                  {price ? (
                    <p className="bl-price">
                      {money(price.amountCents, price.currency)}
                      <small> / {interval === 'month' ? 'month' : 'year'}</small>
                    </p>
                  ) : (
                    <p className="bl-sub">
                      {other ? `Billed ${other.interval === 'year' ? 'yearly' : 'monthly'} only. Switch above to choose it.` : 'Not available yet.'}
                    </p>
                  )}
                  <PlanLimits plan={plan} />
                  {canManage ? (
                    <button
                      type="button"
                      className="wl-btn-primary bl-cta"
                      disabled={!configured || !price?.stripePriceId || busy !== null}
                      onClick={() => go(plan.id, () => startCheckout(account.id, plan.id, interval))}
                    >
                      {busy === plan.id ? 'Opening checkout…' : `Choose ${plan.name}`}
                    </button>
                  ) : (
                    <p className="bl-sub">Ask an owner or admin to choose a plan.</p>
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function PlanLimits({ plan }: { plan: Plan }) {
  return (
    <ul className="bl-limits">
      <li>{plan.includedSkus === null ? 'SKUs by agreement' : `${num.format(plan.includedSkus)} SKUs included`}</li>
      <li>{limit(plan.feedLimit, 'feed', 'feeds')}</li>
      <li>{limit(plan.shopLimit, 'shop', 'shops')}</li>
      <li>{limit(plan.userLimit, 'user', 'users')}</li>
      <li>{plan.syncsPerDay === null ? 'Syncs by agreement' : `${plan.syncsPerDay} sync${plan.syncsPerDay === 1 ? '' : 's'} a day`}</li>
    </ul>
  )
}
