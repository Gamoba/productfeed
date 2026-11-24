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
  pending: 'Venter',
  applied: 'Gennemført',
  rejected: 'Afvist',
  failed: 'Fejlede',
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
      setError('Kunne ikke kopiere. Markér adressen og kopiér den selv.')
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
    if (r.error) setError(`Ændringen kunne ikke gennemføres: ${r.error}`)
    setPending((p) => p.filter((c) => c.id !== change.id))
    setHistory((h) => [{ ...change, status: r.status ?? 'applied', error: r.error ?? null, decided_by_name: 'Dig', decided_at: new Date().toISOString() }, ...h])
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
            Forbind Claude til FeedFlow, og bed den læse og ændre jeres feeds. Den kan nå alle shops i {initial.agencyName}, som
            du kan åbne, og den skriver aldrig til Shopify.
          </p>
        </div>
      </header>

      {error && <p className="note warn" role="alert">{error}</p>}

      <section className="card">
        <div className="mc-card-h">
          <div>
            <h3>Forbind Claude</h3>
            <small>Én forbindelse dækker alle bureauets shops. Hver person forbinder med sit eget login.</small>
          </div>
        </div>
        <div className="mc-url">
          <span className="mc-url-text">{initial.endpoint}</span>
          <button type="button" className="wl-btn-primary mc-btn-sm" onClick={copy}>
            {copied ? '✓ Kopieret' : 'Kopiér adresse'}
          </button>
        </div>
        <ol className="mc-steps">
          <li>Åbn Indstillinger › Connectors i Claude, og vælg <b>Add custom connector</b>.</li>
          <li>Kald den FeedFlow, indsæt adressen ovenfor, og vælg <b>Connect</b>.</li>
          <li>Claude åbner FeedFlow. Log ind, og vælg <b>Giv adgang</b>.</li>
        </ol>
        <p className="mc-muted">På en Claude Team- eller Enterprise-plan skal en ejer måske først tilføje connectoren for organisationen.</p>
      </section>

      <section className="card">
        <div className="mc-card-h">
          <div>
            <h3>Venter på godkendelse</h3>
            <small>Ændringer Claude har bedt om i denne shop. Intet ændres, før nogen godkender.</small>
          </div>
          {pending.length > 0 && <span className="pill warn">{pending.length} venter</span>}
        </div>
        {pending.length === 0 ? (
          <p className="mc-empty">Intet venter. Ændringer Claude beder om, vises her.</p>
        ) : (
          <ul className="mc-changes">
            {pending.map((c) => (
              <li key={c.id} className="mc-change">
                <div className="mc-change-h">
                  <div>
                    <b>{c.summary}</b>
                    <span className="mc-muted">
                      {c.feed_label ?? 'Feed'} · {c.requested_by_name} via {c.client_name ?? 'assistent'} · {formatWhen(c.created_at)}
                    </span>
                  </div>
                  <div className="mc-change-actions">
                    <button type="button" className="wl-btn-secondary mc-btn-sm" disabled={!!busy} onClick={() => decide(c, false)}>
                      Afvis
                    </button>
                    <button type="button" className="wl-btn-primary mc-btn-sm" disabled={!!busy} onClick={() => decide(c, true)}>
                      {busy === `c${c.id}` ? 'Gennemfører…' : 'Godkend'}
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
              <h3>Gennemfør uden godkendelse</h3>
              <small>For alle shops i {initial.agencyName}. Alle ændringer logges stadig i aktivitetsloggen.</small>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoApply}
              aria-label="Gennemfør ændringer fra assistenter uden godkendelse"
              className="mc-switch"
              disabled={!initial.canChangeSetting || busy === 'auto'}
              onClick={toggleAuto}
            >
              <span />
            </button>
          </div>
          <p className="mc-muted">
            {autoApply
              ? 'Til: ændringer fra Claude træder i kraft med det samme.'
              : 'Fra: ændringer Claude beder om, venter her, til nogen godkender dem.'}
            {!initial.canChangeSetting && ' Kun ejere og administratorer kan ændre det.'}
          </p>
        </section>

        <section className="card">
          <div className="mc-card-h">
            <div>
              <h3>Dine forbundne assistenter</h3>
              <small>Apps der kan bruge FeedFlow med dit login.</small>
            </div>
          </div>
          {grants === null ? (
            <p className="mc-muted">Ikke tilgængelig endnu: login for assistenter er ikke slået til for FeedFlow.</p>
          ) : grants.length === 0 ? (
            <p className="mc-empty">Ingen endnu. Forbind Claude med adressen ovenfor.</p>
          ) : (
            <ul className="mc-grants">
              {grants.map((g) => (
                <li key={g.clientId}>
                  <span className="st">{g.name}</span>
                  <span className="mc-muted">siden {formatWhen(g.grantedAt)}</span>
                  <button type="button" className="wl-btn-secondary mc-btn-sm" disabled={!!busy} onClick={() => disconnect(g.clientId)}>
                    Afbryd
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
            <h3>Seneste ændringer fra assistenter</h3>
            <small>De seneste 30 i denne shop.</small>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="mc-empty mc-pad">Ingen ændringer endnu.</p>
        ) : (
          <table className="mc-table">
            <thead>
              <tr>
                <th>Ændring</th>
                <th>Bedt om af</th>
                <th>Status</th>
                <th>Hvornår</th>
              </tr>
            </thead>
            <tbody>
              {history.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.summary}</b>
                    <span className="mc-muted">{c.feed_label ?? ''}</span>
                  </td>
                  <td>
                    {c.requested_by_name} via {c.client_name ?? 'assistent'}
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
          <span className="mc-before">{d.before ?? '(tom)'}</span>
          <span className="mc-arrow" aria-hidden="true">→</span>
          <span className="mc-after">{d.after ?? '(fjernet)'}</span>
        </div>
      ))}
    </div>
  )
}
