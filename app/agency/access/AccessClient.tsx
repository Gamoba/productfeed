'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { ClientAccess } from '@/lib/mcc'
import { decideAccessAction, regenerateCodeAction, revokeAccessAction } from '../mccActions'
import { refreshShell } from '@/app/components/shell/useShell'
import '../agency.css'
import '../mcc.css'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

export function AccessClient({ data, accounts }: { data: ClientAccess | null; accounts: { id: string; name: string }[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState(data?.account.code ?? '')
  const [copied, setCopied] = useState(false)
  const [scopes, setScopes] = useState<Record<string, string>>({})
  const [, start] = useTransition()

  if (!data) {
    return (
      <div className="ag">
        <div className="ag-head">
          <div>
            <h1>Agency access</h1>
            <p className="ag-lede">This page is for customer accounts: it lets a company give an agency access to its feeds.</p>
          </div>
        </div>
      </div>
    )
  }

  function run(key: string, fn: () => Promise<{ error?: string; code?: string }>) {
    setBusy(key)
    setError(null)
    start(async () => {
      const r = await fn()
      if (r.error) setError(r.error)
      if (r.code) setCode(r.code)
      setBusy(null)
      refreshShell()
      router.refresh()
    })
  }

  const manage = data.account.canManage

  return (
    <div className="ag">
      <div className="ag-head">
        <div>
          <h1>Agency access</h1>
          <p className="ag-lede">
            Let an agency work on {data.account.name}&rsquo;s feeds. Give them your access code; you approve each request,
            and you can take access away at any time.
          </p>
        </div>
        {accounts.length > 1 && (
          <select
            className="mc-select"
            aria-label="Account"
            value={data.account.id}
            onChange={(e) => router.push(`/agency/access?account=${e.target.value}`)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <p className="note warn">{error}</p>}

      {manage && (
        <section className="card mc-code">
          <div>
            <span className="mc-eyebrow">Your access code</span>
            <span className="mc-codeval">{code}</span>
            <small className="ag-muted">An agency enters this code to ask for access. Nothing happens until you approve.</small>
          </div>
          <div className="mc-row">
            <button
              type="button"
              className="wl-btn-primary"
              onClick={() => {
                void navigator.clipboard.writeText(code)
                setCopied(true)
                setTimeout(() => setCopied(false), 1800)
              }}
            >
              {copied ? '✓ Copied' : 'Copy code'}
            </button>
            <button
              type="button"
              className="wl-btn-secondary"
              disabled={busy !== null}
              onClick={() => run('code', () => regenerateCodeAction(data.account.id))}
              title="The old code stops working. Agencies that already have access keep it."
            >
              New code
            </button>
          </div>
        </section>
      )}

      {data.pending.length > 0 && (
        <section className="card flush">
          <div className="mc-cardhead">
            <h3>Waiting for your approval</h3>
            <small>Choose what the agency may work on.</small>
          </div>
          <table className="ag-table">
            <tbody>
              {data.pending.map((p) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.agency}</b>
                    <div className="ag-muted">asked {when(p.requestedAt)}</div>
                  </td>
                  <td className="r">
                    {manage ? (
                      <div className="mc-row mc-right">
                        <select
                          className="mc-select"
                          aria-label={`What ${p.agency} may work on`}
                          value={scopes[p.id] ?? ''}
                          onChange={(e) => setScopes({ ...scopes, [p.id]: e.target.value })}
                        >
                          <option value="">All shops and feeds</option>
                          {data.feeds.map((f) => (
                            <option key={f.id} value={f.id}>
                              Only {f.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="wl-btn-primary"
                          disabled={busy !== null}
                          onClick={() => run(p.id, () => decideAccessAction(p.id, true, scopes[p.id] || null))}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="wl-btn-secondary"
                          disabled={busy !== null}
                          onClick={() => run(p.id, () => decideAccessAction(p.id, false, null))}
                        >
                          Decline
                        </button>
                      </div>
                    ) : (
                      <span className="ag-muted">An owner or admin decides</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card flush">
        <div className="mc-cardhead">
          <h3>Agencies with access</h3>
          <small>They can see and change what&rsquo;s listed. Taking access away works at once.</small>
        </div>
        {data.agencies.length === 0 ? (
          <div className="ag-empty">
            <p>No agency has access. Give an agency your access code to start.</p>
          </div>
        ) : (
          <table className="ag-table">
            <thead>
              <tr>
                <th>Agency</th>
                <th>Access</th>
                <th>Since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.agencies.map((a) => (
                <tr key={a.id}>
                  <td>
                    <b>{a.agency}</b>
                    {a.referred && <div className="ag-muted">Brought you to Kompara</div>}
                  </td>
                  <td>{a.scope === 'account' ? 'All shops and feeds' : `Only ${a.feed ?? 'one feed'}`}</td>
                  <td>{when(a.since)}</td>
                  <td className="r">
                    {manage && (
                      <button
                        type="button"
                        className="wl-btn-secondary"
                        disabled={busy !== null}
                        onClick={() => {
                          if (confirm(`Take away ${a.agency}'s access?`)) run(a.id, () => revokeAccessAction(a.id))
                        }}
                      >
                        Remove access
                      </button>
                    )}
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
