'use client'

import { useState } from 'react'
import { formatWhen } from '@/lib/formatDa'
import type { ChangeRow } from '@/lib/mcp/changes'
import { decideMcpChange, disconnectAssistant, setMcpAutoApply } from './actions'
import './mcp.css'

export type McpState = {
  projectId: string
  endpoint: string
  agencyName: string
  autoApply: boolean
  canChangeSetting: boolean
  pending: ChangeRow[]
  history: ChangeRow[]
  grants: { clientId: string; name: string; grantedAt: string }[] | null
}

const STATUS: Record<ChangeRow['status'], string> = {
  pending: 'Waiting',
  applied: 'Applied',
  rejected: 'Rejected',
  failed: 'Failed',
}

export function McpClient({ initial }: { initial: McpState }) {
  const [pending, setPending] = useState(initial.pending)
  const [history, setHistory] = useState(initial.history)
  const [autoApply, setAutoApply] = useState(initial.autoApply)
  const [grants, setGrants] = useState(initial.grants)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(initial.endpoint)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy. Select the address and copy it by hand.')
    }
  }

  async function decide(change: ChangeRow, approve: boolean) {
    setBusy(`c${change.id}`)
    setError(null)
    const r = await decideMcpChange(initial.projectId, change.id, approve)
    setBusy(null)
    if (r.error && !r.status) {
      setError(r.error)
      return
    }
    if (r.error) setError(`The change could not be applied: ${r.error}`)
    setPending((p) => p.filter((c) => c.id !== change.id))
    setHistory((h) => [{ ...change, status: r.status ?? 'applied', error: r.error ?? null, decided_by_name: 'You', decided_at: new Date().toISOString() }, ...h])
  }

  async function toggleAuto() {
    const next = !autoApply
    setBusy('auto')
    setError(null)
    const r = await setMcpAutoApply(initial.projectId, next)
    setBusy(null)
    if (r.error) setError(r.error)
    else setAutoApply(next)
  }

  async function disconnect(clientId: string) {
    setBusy(`g${clientId}`)
    setError(null)
    const r = await disconnectAssistant(clientId)
    setBusy(null)
    if (r.error) setError(r.error)
    else setGrants((g) => (g ?? []).filter((x) => x.clientId !== clientId))
  }

  return (
    <div className="mc">
      <header className="mc-head">
        <div>
          <h1>API / MCP</h1>
          <p className="mc-lede">
            Connect Claude to FeedFlow and ask it to read and change your feeds. It reaches every shop in {initial.agencyName} that
            you can open, and it never writes to Shopify.
          </p>
        </div>
      </header>

      {error && <p className="note warn" role="alert">{error}</p>}

      <section className="card">
        <div className="mc-card-h">
          <div>
            <h3>Connect Claude</h3>
            <small>One connection covers all the agency&apos;s shops. Each person connects with their own login.</small>
          </div>
        </div>
        <div className="mc-url">
          <span className="mc-url-text">{initial.endpoint}</span>
          <button type="button" className="wl-btn-primary mc-btn-sm" onClick={copy}>
            {copied ? '✓ Copied' : 'Copy address'}
          </button>
        </div>
        <ol className="mc-steps">
          <li>In Claude, open Settings › Connectors and choose <b>Add custom connector</b>.</li>
          <li>Name it FeedFlow, paste the address above and choose <b>Connect</b>.</li>
          <li>Claude opens FeedFlow. Sign in and choose <b>Allow access</b>.</li>
        </ol>
        <p className="mc-muted">On a Claude Team or Enterprise plan, an owner may have to add the connector for the organisation first.</p>
      </section>

      <section className="card">
        <div className="mc-card-h">
          <div>
            <h3>Waiting for approval</h3>
            <small>Changes Claude has asked for in this shop. Nothing changes until someone approves.</small>
          </div>
          {pending.length > 0 && <span className="pill warn">{pending.length} waiting</span>}
        </div>
        {pending.length === 0 ? (
          <p className="mc-empty">Nothing is waiting. Changes Claude asks for show up here.</p>
        ) : (
          <ul className="mc-changes">
            {pending.map((c) => (
              <li key={c.id} className="mc-change">
                <div className="mc-change-h">
                  <div>
                    <b>{c.summary}</b>
                    <span className="mc-muted">
                      {c.feed_label ?? (c.feed_id ? 'Feed' : 'Shop')} · {c.requested_by_name} via {c.client_name ?? 'assistant'} · {formatWhen(c.created_at)}
                    </span>
                  </div>
                  <div className="mc-change-actions">
                    <button type="button" className="wl-btn-secondary mc-btn-sm" disabled={!!busy} onClick={() => decide(c, false)}>
                      Reject
                    </button>
                    <button type="button" className="wl-btn-primary mc-btn-sm" disabled={!!busy} onClick={() => decide(c, true)}>
                      {busy === `c${c.id}` ? 'Applying…' : 'Approve'}
                    </button>
                  </div>
                </div>
                <Details change={c} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mc-two">
        <section className="card">
          <div className="mc-card-h">
            <div>
              <h3>Apply without approval</h3>
              <small>For all shops in {initial.agencyName}. Every change is still logged in the Activity log.</small>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoApply}
              aria-label="Apply changes from assistants without approval"
              className="mc-switch"
              disabled={!initial.canChangeSetting || busy === 'auto'}
              onClick={toggleAuto}
            >
              <span />
            </button>
          </div>
          <p className="mc-muted">
            {autoApply
              ? 'On: changes Claude makes take effect at once.'
              : 'Off: changes Claude asks for wait here until someone approves them.'}
            {!initial.canChangeSetting && ' Only owners and admins can change this.'}
          </p>
        </section>

        <section className="card">
          <div className="mc-card-h">
            <div>
              <h3>Your connected assistants</h3>
              <small>Apps that can use FeedFlow with your login.</small>
            </div>
          </div>
          {grants === null ? (
            <p className="mc-muted">Not available yet: sign-in for assistants is not switched on for FeedFlow.</p>
          ) : grants.length === 0 ? (
            <p className="mc-empty">None yet. Connect Claude with the address above.</p>
          ) : (
            <ul className="mc-grants">
              {grants.map((g) => (
                <li key={g.clientId}>
                  <span className="st">{g.name}</span>
                  <span className="mc-muted">since {formatWhen(g.grantedAt)}</span>
                  <button type="button" className="wl-btn-secondary mc-btn-sm" disabled={!!busy} onClick={() => disconnect(g.clientId)}>
                    Disconnect
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card flush">
        <div className="mc-card-h mc-pad">
          <div>
            <h3>Recent changes from assistants</h3>
            <small>The last 30 in this shop.</small>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="mc-empty mc-pad">No changes yet.</p>
        ) : (
          <table className="mc-table">
            <thead>
              <tr>
                <th>Change</th>
                <th>Asked by</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.summary}</b>
                    <span className="mc-muted">{c.feed_label ?? (c.feed_id ? '' : 'Shop')}</span>
                  </td>
                  <td>
                    {c.requested_by_name} via {c.client_name ?? 'assistant'}
                  </td>
                  <td>
                    {c.status === 'applied' ? (
                      <span className="st">{STATUS.applied}</span>
                    ) : (
                      <span className={c.status === 'failed' ? 'mc-bad' : 'mc-muted'} title={c.error ?? undefined}>
                        {STATUS[c.status]}
                      </span>
                    )}
                    {c.decided_by_name && <span className="mc-muted">{c.decided_by_name}</span>}
                  </td>
                  <td className="mc-muted">{formatWhen(c.decided_at ?? c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

function Details({ change }: { change: ChangeRow }) {
  if (!change.details?.length) return null
  return (
    <div className="mc-details">
      {change.details.map((d, i) => (
        <div key={i} className="mc-detail">
          <span className="mc-detail-label">{d.label}</span>
          <span className="mc-before">{d.before ?? '(empty)'}</span>
          <span className="mc-arrow" aria-hidden="true">→</span>
          <span className="mc-after">{d.after ?? '(removed)'}</span>
        </div>
      ))}
    </div>
  )
}
