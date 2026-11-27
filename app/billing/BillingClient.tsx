'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AccountBilling, BillingDetail, BillingUsage, Interval, Plan } from '@/lib/billing'
import { addAddonAction, openPortal, removeAddonAction, startCheckout, switchPlanAction } from './actions'
import '../agency/agency.css'
import './billing.css'

type Props = {
  billing: AccountBilling
  plans: Plan[]
  canManage: boolean
  configured: boolean
  detail: BillingDetail
  /** Set when ?account named an account the user doesn't manage. */
  unmanaged: { name: string | null } | null
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

export function BillingClient({ billing, plans, canManage, configured, detail, unmanaged, checkoutNote }: Props) {
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
          {manageButton}
        </div>
      </div>

      {unmanaged && (
        <p className="note">
          {unmanaged.name ? `${unmanaged.name} is on its own plan` : 'That account is on its own plan'}, and only its owners
          and admins can change it. Below is {account.name}.
        </p>
      )}
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
          {detail.addons.length > 0 && (
            <ul className="bl-limits">
              {detail.addons.map((a) => (
                <li key={a.id}>
                  {a.name}
                  {a.quantity > 1 ? ` × ${a.quantity}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : subscription ? (
        <>
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
          {current && <PlanLimits plan={current} addons={detail.addons} />}
          {!canManage && <p className="bl-sub">Owners and admins can change the plan.</p>}
        </section>
        {plans
          .filter((p) => p.isCustom && p.active && p.id !== subscription.planId)
          .map((p) => (
            <CustomOffer
              key={p.id}
              accountId={account.id}
              plan={p}
              current={subscription.interval}
              canSwitch={canManage && configured && subscription.status !== 'past_due' && !subscription.cancelAt}
            />
          ))}
        <Usage usage={detail.usage} />
        <AddonList accountId={account.id} detail={detail} canManage={canManage && configured} interval={subscription.interval} />
        </>
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
                        href={`mailto:${contactEmail}?subject=${encodeURIComponent('Kompara Enterprise')}`}
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
                      {busy === plan.id ? 'Opening checkout…' : plan.isCustom ? 'Choose this plan' : `Choose ${plan.name}`}
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

// A custom plan made for an account that already pays for a plan: switching
// swaps the price on its subscription (lib/billing.ts switchToCustomPlan),
// since neither Checkout nor the Stripe portal can.
function CustomOffer({ accountId, plan, current, canSwitch }: { accountId: string; plan: Plan; current: Interval; canSwitch: boolean }) {
  const router = useRouter()
  const [, start] = useTransition()
  const [confirm, setConfirm] = useState<Interval | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The current interval first: it keeps the renewal date and any add-ons.
  const prices = [...plan.prices].filter((p) => p.stripePriceId).sort((a, b) => Number(b.interval === current) - Number(a.interval === current))

  function doSwitch(interval: Interval) {
    setBusy(true)
    setError(null)
    start(async () => {
      const r = await switchPlanAction(accountId, plan.id, interval)
      setBusy(false)
      setConfirm(null)
      if (r.error) setError(r.error)
      else router.refresh()
    })
  }

  return (
    <section className="card bl-plan">
      <h3>
        {plan.name}
        <span className="pill ai">Made for you</span>
      </h3>
      <p className="bl-sub">A plan we set up for you. Switch to it here; it replaces your current plan.</p>
      <PlanLimits plan={plan} />
      {error && <p className="note warn">{error}</p>}
      {!canSwitch ? (
        <p className="bl-sub">Owners and admins can switch once the plan is active and not set to end.</p>
      ) : confirm ? (
        <div className="bl-row">
          <p className="bl-sub" style={{ flexBasis: '100%' }}>
            {confirm === current
              ? 'Stripe charges or credits the difference for the rest of this period now, to the card on file.'
              : `This starts a new ${confirm === 'year' ? 'yearly' : 'monthly'} period today. Stripe credits what’s left of the current one and charges the card on file now.`}
          </p>
          <button type="button" className="wl-btn-primary" disabled={busy} onClick={() => doSwitch(confirm)}>
            {busy ? 'Switching…' : 'Confirm switch'}
          </button>
          <button type="button" className="wl-btn-secondary" disabled={busy} onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="bl-row">
          {prices.map((p, i) => (
            <button
              key={p.interval}
              type="button"
              className={i === 0 ? 'wl-btn-primary bl-cta' : 'wl-btn-secondary bl-cta'}
              onClick={() => setConfirm(p.interval)}
            >
              Switch · {money(p.amountCents, p.currency)} / {p.interval}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function PlanLimits({ plan, addons = [] }: { plan: Plan; addons?: BillingDetail['addons'] }) {
  // Add-ons raise the plan's limits (lib/addons.ts), so each line shows the
  // plan's own figure and what the add-ons add.
  const extra = {
    feed: addons.reduce((n, a) => n + a.feedDelta * a.quantity, 0),
    shop: addons.reduce((n, a) => n + a.shopDelta * a.quantity, 0),
    user: addons.reduce((n, a) => n + a.userDelta * a.quantity, 0),
    sku: addons.reduce((n, a) => n + a.skuDelta * a.quantity, 0),
  }
  const plus = (n: number) => (n > 0 ? ` + ${num.format(n)} from add-ons` : '')
  return (
    <ul className="bl-limits">
      <li>
        {plan.includedSkus === null ? 'SKUs by agreement' : `${num.format(plan.includedSkus)} SKUs included`}
        {plan.includedSkus === null ? '' : plus(extra.sku)}
      </li>
      <li>
        {limit(plan.feedLimit, 'feed', 'feeds')}
        {plan.feedLimit === null ? '' : plus(extra.feed)}
      </li>
      <li>
        {limit(plan.shopLimit, 'shop', 'shops')}
        {plan.shopLimit === null ? '' : plus(extra.shop)}
      </li>
      <li>
        {limit(plan.userLimit, 'user', 'users')}
        {plan.userLimit === null ? '' : plus(extra.user)}
      </li>
      <li>{plan.syncsPerDay === null ? 'Syncs by agreement' : `${plan.syncsPerDay} sync${plan.syncsPerDay === 1 ? '' : 's'} a day`}</li>
    </ul>
  )
}

const monthName = (month: string) =>
  new Date(`${month}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

// This month's SKUs. Extras are billed once the month is over
// (lib/extraSkus.ts), so these are the figures so far.
function Usage({ usage }: { usage: BillingUsage }) {
  const b = usage.basis
  if (!b) return null
  const priced = b.includedSkus !== null && b.ratePer1000Cents !== null
  return (
    <section className="card bl-usage">
      <div className="bl-current-head">
        <h3>SKUs in {monthName(usage.month)}</h3>
        {b.measuredDays > 0 && b.extraThousands > 0 && (
          <span className="bl-extra">{money(b.amountCents, b.currency)} extra so far</span>
        )}
      </div>
      {b.measuredDays === 0 ? (
        <p className="bl-sub">Not counted yet. The first count runs within a day of the plan starting.</p>
      ) : (
        <ul className="bl-figures">
          <li>
            <b>{num.format(b.peakSkus)}</b>
            <small>highest day this month</small>
          </li>
          <li>
            <b>{b.includedSkus === null ? '—' : num.format(b.includedSkus)}</b>
            <small>included</small>
          </li>
          <li>
            <b>{num.format(b.extraThousands * 1000)}</b>
            <small>extra, in thousands</small>
          </li>
          <li>
            <b>{money(b.amountCents, b.currency)}</b>
            <small>extra so far</small>
          </li>
        </ul>
      )}
      <p className="bl-sub">
        A SKU is an item that goes out in a feed: a product, or a variant where the feed&rsquo;s Level is &ldquo;Per
        variant&rdquo;. It counts once per shop, however many of your feeds send it. The month is billed on its highest day
        {priced ? `, at ${money(b.ratePer1000Cents as number, b.currency)} per 1,000 above the plan` : ''}, once the month ends.
      </p>
      {usage.cheaper && (
        <p className="note">
          At this month&rsquo;s peak, {usage.cheaper.name} would come to{' '}
          {money(usage.cheaper.wouldCostCents, usage.cheaper.currency)} against{' '}
          {money(usage.cheaper.nowCostCents, usage.cheaper.currency)} on your plan. You can switch under Manage billing.
        </p>
      )}
      {usage.charges.length > 0 && (
        <table className="ag-table bl-months">
          <thead>
            <tr>
              <th>Month</th>
              <th className="r">Highest day</th>
              <th className="r">Extra SKUs</th>
              <th className="r">Billed</th>
            </tr>
          </thead>
          <tbody>
            {usage.charges.map((c) => (
              <tr key={c.month}>
                <td>{monthName(c.month)}</td>
                <td className="r">{num.format(c.peakSkus)}</td>
                <td className="r">{num.format(c.extraThousands * 1000)}</td>
                <td className="r">{c.status === 'none' ? 'nothing' : money(c.amountCents, c.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// The add-ons the account has, and the ones it can buy. Both go straight onto
// the Stripe subscription, which settles the rest of the period.
function AddonList({
  accountId,
  detail,
  canManage,
  interval,
}: {
  accountId: string
  detail: BillingDetail
  canManage: boolean
  /** The plan's interval: an add-on is billed with the plan, at its interval. */
  interval: Interval | null
}) {
  const hasPlan = interval !== null
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [qty, setQty] = useState<Record<string, string>>({})
  const [, start] = useTransition()
  const owned = new Set(detail.addons.map((a) => a.addonId))
  // Only what the customer may buy itself; the rest only Gamoba puts on.
  const available = detail.catalogue.filter((a) => a.selfServe && (!owned.has(a.id) || a.quantityEnabled))

  function run(key: string, fn: () => Promise<{ ok?: true; error?: string }>) {
    setBusy(key)
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      setBusy(null)
      router.refresh()
    })
  }

  if (!detail.addons.length && !(hasPlan && available.length)) return null

  return (
    <section className="card bl-addons">
      <div className="bl-current-head">
        <h3>Add-ons</h3>
      </div>
      <p className="bl-sub">
        Extras on top of the plan. They go on the same invoice, and Stripe settles the part of the period that is left.
      </p>
      {error && <p className="note warn">{error}</p>}

      {detail.addons.length > 0 && (
        <ul className="bl-addon-list">
          {detail.addons.map((a) => (
            <li key={a.id}>
              <div>
                <b>
                  {a.name}
                  {a.quantity > 1 ? ` × ${a.quantity}` : ''}
                </b>
                {a.description && <small>{a.description}</small>}
                {a.free && <small>Included by us, at no charge.</small>}
              </div>
              <div className="bl-addon-right">
                <span>
                  {a.free
                    ? 'Free'
                    : a.unitAmountCents === null
                      ? ''
                      : `${money(a.unitAmountCents * a.quantity, a.currency)} / ${a.interval === 'year' ? 'year' : 'month'}`}
                </span>
                {canManage && !a.free && (
                  <button
                    type="button"
                    className="link"
                    disabled={busy !== null}
                    onClick={() => run(`rm-${a.addonId}`, () => removeAddonAction(accountId, a.addonId))}
                  >
                    {busy === `rm-${a.addonId}` ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {hasPlan && available.length > 0 && (
        <ul className="bl-addon-list bl-addon-buy">
          {available.map((a) => (
            <li key={a.id}>
              <div>
                <b>{a.name}</b>
                {a.description && <small>{a.description}</small>}
                {owned.has(a.id) && <small>You have this already; adding more raises the quantity.</small>}
              </div>
              <div className="bl-addon-right">
                <span>
                  {(() => {
                    const p = a.prices.find((x) => x.interval === interval && x.stripePriceId)
                    return p
                      ? `${money(p.amountCents, p.currency)} / ${p.interval === 'year' ? 'year' : 'month'}${a.quantityEnabled ? ' each' : ''}`
                      : `Not available ${interval === 'year' ? 'yearly' : 'monthly'} yet`
                  })()}
                </span>
                {canManage ? (
                  <>
                    {a.quantityEnabled && (
                      <input
                        className="bl-qty"
                        inputMode="numeric"
                        aria-label={`How many of ${a.name}`}
                        value={qty[a.id] ?? '1'}
                        onChange={(e) => setQty({ ...qty, [a.id]: e.target.value })}
                      />
                    )}
                    <button
                      type="button"
                      className="wl-btn-secondary"
                      disabled={busy !== null || !a.prices.some((x) => x.interval === interval && x.stripePriceId)}
                      onClick={() => run(`add-${a.id}`, () => addAddonAction(accountId, a.id, qty[a.id] ?? '1'))}
                    >
                      {busy === `add-${a.id}` ? 'Adding…' : 'Add'}
                    </button>
                  </>
                ) : (
                  <span className="bl-sub">Owners and admins can add this.</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

