'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { AgencyClients } from '@/lib/mcc'
import { requestAccessAction } from '../mccActions'
import { LimitNote, readLimitError } from '@/app/components/LimitNote'
import { refreshShell } from '@/app/components/shell/useShell'
import '../agency.css'
import '../mcc.css'

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—')

export function CompaniesClient({ data }: { data: AgencyClients | null }) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [, start] = useTransition()
  const [adding, setAdding] = useState<{ accountId: string; name: string } | null>(null)

  if (!data) {
    return (
      <div className="ag">
        <div className="ag-head">
          <div>
            <h1>Connected companies</h1>
            <p className="ag-lede">
              This page is for agencies. Agencies are set up by Gamoba; if you&rsquo;re an agency and want to work on your
              clients&rsquo; feeds in Kompara, contact us.
            </p>
          </div>
        </div>
      </div>
    )
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    start(async () => {
      const r = await requestAccessAction(data!.agency.id, code)
      setMsg(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? 'Request sent.' })
      if (!r.error) setCode('')
      setBusy(false)
      router.refresh()
    })
  }

  return (
    <div className="ag">
      <div className="ag-head">
        <div>
          <h1>Connected companies</h1>
          <p className="ag-lede">
            The companies {data.agency.name} works for. Everyone in the agency can open their shops and feeds; the company
            decides how much access you have.
          </p>
        </div>
      </div>

      <section className="card">
        <div>
          <h3 className="mc-h3">Connect a company</h3>
          <small className="ag-muted">Ask the company for its access code (under Agency access in their account).</small>
        </div>
        <form className="mc-form" onSubmit={submit}>
          <input
            className="mc-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code, e.g. K7M2QX9TAB"
            aria-label="Access code"
            autoComplete="off"
            required
          />
          <button type="submit" className="wl-btn-primary" disabled={busy || !code.trim()}>
            {busy ? 'Sending…' : 'Ask for access'}
          </button>
        </form>
        {msg && <p className={msg.ok ? 'note' : 'note warn'}>{msg.text}</p>}
      </section>

      {data.pending.length > 0 && (
        <section className="card flush">
          <div className="mc-cardhead">
            <h3>Waiting for approval</h3>
            <small>The company needs to approve these.</small>
          </div>
          <table className="ag-table">
            <tbody>
              {data.pending.map((p) => (
                <tr key={p.grantId}>
                  <td>
                    <b>{p.name}</b>
                  </td>
                  <td className="r ag-muted">asked {when(p.requestedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card flush">
        <div className="mc-cardhead">
          <h3>Clients</h3>
          <small>Open a client&rsquo;s shops from the Agency dashboard, or add a shop for them here.</small>
        </div>
        {data.clients.length === 0 ? (
          <div className="ag-empty">
            <p>No clients yet. Share your referral link (under Partner levels), or ask a company for its access code.</p>
          </div>
        ) : (
          <table className="ag-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Access</th>
                <th className="r">Shops</th>
                <th>Since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.grantId}>
                  <td>
                    <b>{c.name}</b>
                    {c.referred && <div className="ag-muted">Your referral</div>}
                  </td>
                  <td>{c.scope === 'account' ? 'All shops and feeds' : `Only ${c.feed?.label ?? 'one feed'}`}</td>
                  <td className="r">{c.scope === 'account' ? c.shops : '—'}</td>
                  <td>{when(c.since)}</td>
                  <td className="r">
                    {c.scope === 'feed' && c.feed ? (
                      <a className="link" href={`/feed/${c.feed.id}`}>
                        Open feed
                      </a>
                    ) : (
                      <button type="button" className="wl-btn-secondary" onClick={() => setAdding({ accountId: c.accountId, name: c.name })}>
                        Add shop
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {adding && (
        <AddShopDialog
          client={adding}
          onClose={() => setAdding(null)}
          onDone={(id) => {
            refreshShell()
            router.push(`/project/${id}`)
          }}
        />
      )}
    </div>
  )
}

function AddShopDialog({
  client,
  onClose,
  onDone,
}: {
  client: { accountId: string; name: string }
  onClose: () => void
  onDone: (projectId: string) => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [upgrade, setUpgrade] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    // Created in the client's account; counts against the client's plan.
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), account_id: client.accountId }),
    })
    if (!res.ok) {
      const r = await readLimitError(res)
      setError(r.error)
      // The upgrade link is the client's billing, which the agency can't open.
      setUpgrade(null)
      setBusy(false)
      return
    }
    const d = (await res.json()) as { project?: { id: string } }
    if (d.project?.id) onDone(d.project.id)
  }

  return (
    <div className="ag-overlay" role="dialog" aria-modal="true" aria-label={`Add a shop for ${client.name}`} onClick={onClose}>
      <form className="ag-dlg card" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <h3 className="mc-h3">Add a shop for {client.name}</h3>
        <label className="ag-field">
          <span>Shop name</span>
          <input className="ag-inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        <p className="ag-muted">The shop belongs to {client.name} and counts against their plan.</p>
        <LimitNote error={error} upgrade={upgrade} />
        <div className="ag-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="wl-btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Adding…' : 'Add shop'}
          </button>
        </div>
      </form>
    </div>
  )
}
