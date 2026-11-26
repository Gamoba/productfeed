'use client'

import { useState } from 'react'
import type { PartnerOverview } from '@/lib/mcc'
import '../agency.css'
import '../mcc.css'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)
const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 1000) / 10} %`)
const STATUS: Record<string, { text: string; cls: string }> = {
  pending: { text: 'Signed up, not paid yet', cls: 'ag-muted' },
  active: { text: 'Earning', cls: 'mc-good' },
  stopped: { text: 'Stopped (access removed)', cls: 'mc-bad' },
}

export function PartnerClient({ data, signupBase }: { data: PartnerOverview | null; signupBase: string }) {
  const [copied, setCopied] = useState(false)

  if (!data) {
    return (
      <div className="ag">
        <div className="ag-head">
          <div>
            <h1>Partner levels</h1>
            <p className="ag-lede">This page is for agencies: their referral link and what they earn on the clients they bring.</p>
          </div>
        </div>
      </div>
    )
  }

  const link = `${signupBase}${data.referralCode}`

  return (
    <div className="ag">
      <div className="ag-head">
        <div>
          <h1>Partner levels</h1>
          <p className="ag-lede">
            {data.agency.name} earns {pct(data.agency.rate)} of what each client you bring to Kompara pays, excl. VAT, for as
            long as they pay. Paid out monthly.
          </p>
        </div>
      </div>

      <section className="card hi-lite">
        <span className="mc-eyebrow">Your referral link</span>
        <div className="mc-row">
          <span className="mc-link">{link}</span>
          <button
            type="button"
            className="wl-btn-primary"
            onClick={() => {
              void navigator.clipboard.writeText(link)
              setCopied(true)
              setTimeout(() => setCopied(false), 1800)
            }}
          >
            {copied ? '✓ Copied' : 'Copy link'}
          </button>
        </div>
        <small className="ag-muted">
          Companies that sign up through this link become your clients straight away, with access to all their shops.
        </small>
      </section>

      <section className="card flush">
        <div className="mc-stats">
          <div>
            <span>Due now</span>
            <strong className={data.dueCents < 0 ? 'mc-bad' : undefined}>{money(data.dueCents, data.currency)}</strong>
            <small className="ag-muted">
              {data.dueCents < 0 ? 'a refund, deducted from your next payout' : 'paid out by Gamoba'}
            </small>
          </div>
          <div>
            <span>Coming months</span>
            <strong>{money(data.upcomingCents, data.currency)}</strong>
            <small className="ag-muted">from yearly plans</small>
          </div>
          <div>
            <span>Paid out</span>
            <strong>{money(data.paidCents, data.currency)}</strong>
            <small className="ag-muted">so far</small>
          </div>
          <div>
            <span>Referred clients</span>
            <strong>{data.referrals.length}</strong>
            <small className="ag-muted">{data.referrals.filter((r) => r.status === 'active').length} earning</small>
          </div>
        </div>
      </section>

      <section className="card flush">
        <div className="mc-cardhead">
          <h3>Referred clients</h3>
          <small>Earning starts with the client&rsquo;s first payment.</small>
        </div>
        {data.referrals.length === 0 ? (
          <div className="ag-empty">
            <p>No referrals yet. Share your link with a company to start.</p>
          </div>
        ) : (
          <table className="ag-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th className="r">Rate</th>
                <th>Signed up</th>
                <th>First paid</th>
              </tr>
            </thead>
            <tbody>
              {data.referrals.map((r, i) => (
                <tr key={i}>
                  <td>
                    <b>{r.name}</b>
                  </td>
                  <td className={STATUS[r.status]?.cls}>{STATUS[r.status]?.text ?? r.status}</td>
                  <td className="r">{pct(r.rate)}</td>
                  <td>{when(r.signedUpAt)}</td>
                  <td>{when(r.firstPaidAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {data.payouts.length > 0 && (
        <section className="card flush">
          <div className="mc-cardhead">
            <h3>Payouts</h3>
          </div>
          <table className="ag-table">
            <tbody>
              {data.payouts.map((p, i) => (
                <tr key={i}>
                  <td>{when(p.paidAt)}</td>
                  <td className="ag-muted">{p.reference ?? ''}</td>
                  <td className="r">{money(p.totalCents, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
