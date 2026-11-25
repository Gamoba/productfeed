'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgencyOverview, AgencyShop } from '@/lib/agencyOverview'
import { Icon } from '@/app/components/shell/icons'
import { Popover } from '@/app/components/shell/Popover'
import { flagEmoji, initials } from '@/app/components/shell/nav'
import { countryName, formatNumber } from '@/lib/formatDa'
import { refreshShell } from '@/app/components/shell/useShell'
import './agency.css'

export function AgencyDashboardClient({ initial }: { initial: AgencyOverview }) {
  const router = useRouter()
  const [shops, setShops] = useState(initial.shops)
  const [creating, setCreating] = useState(false)

  const withFeeds = shops.filter((s) => s.liveFeeds > 0).length
  const feedTotal = shops.reduce((n, s) => n + s.feeds, 0)
  const errorTotal = shops.reduce((n, s) => n + s.errors, 0)
  const shopsWithErrors = shops.filter((s) => s.errors > 0).length

  return (
    <div className="ag">
      <header className="ag-head">
        <div>
          <h1>Agency dashboard</h1>
          <p className="ag-lede">Alle de kunder, bureauet har adgang til. Klik på en kunde for at åbne shoppen med dens feeds.</p>
        </div>
        <button type="button" className="wl-btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> Opret kunde
        </button>
      </header>

      <section className="card flush">
        <div className="ag-stats">
          <div>
            <span>Kunder</span>
            <strong className="num">{formatNumber(shops.length)}</strong>
            <small>
              {formatNumber(withFeeds)} med feeds i drift
            </small>
          </div>
          <div>
            <span>Feeds i alt</span>
            <strong className="num">{formatNumber(feedTotal)}</strong>
            <small>på tværs af kunder</small>
          </div>
          <div>
            <span>Fejl der kræver handling</span>
            <strong className={`num${errorTotal > 0 ? ' neg' : ''}`}>{formatNumber(errorTotal)}</strong>
            <small>
              {errorTotal === 0
                ? 'Alle feeds er klar'
                : `hos ${formatNumber(shopsWithErrors)} ${shopsWithErrors === 1 ? 'kunde' : 'kunder'}`}
            </small>
          </div>
        </div>

        {shops.length === 0 ? (
          <div className="ag-empty">
            <p>Ingen kunder endnu. Opret den første, og forbind dens Shopify-shop eller feed-URL.</p>
            <button type="button" className="wl-btn-primary" onClick={() => setCreating(true)}>
              Opret første kunde
            </button>
          </div>
        ) : (
          <div className="ag-tablewrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th>Kunde</th>
                  <th>Adgang</th>
                  <th>Land</th>
                  <th className="r">Feeds</th>
                  <th className="r">Fejl</th>
                  <th aria-label="Handlinger" />
                </tr>
              </thead>
              <tbody>
                {shops.map((s) => (
                  <ShopRow
                    key={s.id}
                    shop={s}
                    showAccount={initial.multipleAccounts}
                    onOpen={() => router.push(`/project/${s.id}`)}
                    onRenamed={(name) => setShops((all) => all.map((x) => (x.id === s.id ? { ...x, name } : x)))}
                    onDeleted={() => setShops((all) => all.filter((x) => x.id !== s.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="ag-foot">
        Fejl tæller valideringsfejl i feeds og feeds, hvis varer ikke er synkroniseret i over to døgn. Advarsler er ikke med.
      </p>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

// ── one customer ─────────────────────────────────────────────────────────────

function Access({ shop }: { shop: AgencyShop }) {
  if (shop.source === 'feed_url') return <span className="st">Feed-URL</span>
  if (shop.connection === 'connected') return <span className="st">Shopify forbundet</span>
  if (shop.connection === 'error') return <span className="neg">Shopify fejler</span>
  return <span className="pill warn">Ikke forbundet</span>
}

function ShopRow({
  shop,
  showAccount,
  onOpen,
  onRenamed,
  onDeleted,
}: {
  shop: AgencyShop
  showAccount: boolean
  onOpen: () => void
  onRenamed: (name: string) => void
  onDeleted: () => void
}) {
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const sub = [shop.address, showAccount ? shop.accountName : null].filter(Boolean).join(' · ')

  return (
    <tr
      className="ag-row"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <td>
        <span className="ag-shop">
          <span className="ag-av" aria-hidden="true">
            {initials(shop.name)}
          </span>
          <span>
            <b>{shop.name}</b>
            <small>{sub || 'Ingen kilde endnu'}</small>
          </span>
        </span>
      </td>
      <td>
        <Access shop={shop} />
      </td>
      <td>
        {shop.countries.length === 0 ? (
          <span className="ag-muted">—</span>
        ) : (
          <span className="ag-flags" title={shop.countries.map(countryName).join(', ')}>
            {shop.countries.slice(0, 4).map((c) => (
              <span key={c}>{flagEmoji(c) || c}</span>
            ))}
            {shop.countries.length > 4 && <small>+{shop.countries.length - 4}</small>}
          </span>
        )}
      </td>
      <td className="r num">{shop.feeds === 0 ? <span className="ag-muted">0</span> : formatNumber(shop.feeds)}</td>
      <td className={`r num${shop.errors > 0 ? ' neg' : ''}`}>
        {shop.errors === 0 ? <span className="ag-muted">0</span> : formatNumber(shop.errors)}
      </td>
      <td className="r ag-act" onClick={stop} onKeyDown={stop}>
        <Link href={`/project/${shop.id}`} className="link">
          Åbn kunde
        </Link>
        <Popover
          label={`Flere handlinger for ${shop.name}`}
          align="right"
          triggerClassName="ag-more"
          trigger={<span aria-hidden="true">⋯</span>}
        >
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                className="shell-menu-item"
                onClick={() => {
                  close()
                  setDialog('rename')
                }}
              >
                Omdøb
              </button>
              <button
                type="button"
                role="menuitem"
                className="shell-menu-item neg"
                onClick={() => {
                  close()
                  setDialog('delete')
                }}
              >
                Slet kunde
              </button>
            </>
          )}
        </Popover>
        {dialog === 'rename' && (
          <RenameDialog
            shop={shop}
            onClose={() => setDialog(null)}
            onSaved={(name) => {
              onRenamed(name)
              refreshShell()
              setDialog(null)
            }}
          />
        )}
        {dialog === 'delete' && (
          <DeleteDialog
            shop={shop}
            onClose={() => setDialog(null)}
            onDeleted={() => {
              setDialog(null)
              onDeleted()
              refreshShell()
            }}
          />
        )}
      </td>
    </tr>
  )
}

// ── dialogs ──────────────────────────────────────────────────────────────────

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Portalled to <body> so the table row can't clip or contain the backdrop.
  return createPortal(
    <div className="ag-overlay" onClick={onClose}>
      <div
        className="ag-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  )
}

async function readError(res: Response): Promise<string> {
  const j = (await res.json().catch(() => ({}))) as { error?: string }
  return j.error ?? `HTTP ${res.status}`
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: description.trim() }),
    })
    if (!res.ok) {
      setError(await readError(res))
      setBusy(false)
      return
    }
    const data = (await res.json()) as { project?: { id: string } }
    // Land on the new shop, where the source is connected next.
    if (data.project?.id) router.push(`/project/${data.project.id}`)
  }

  return (
    <Dialog title="Opret kunde" onClose={onClose}>
      <form className="ag-dlg-body" onSubmit={submit}>
        <label className="ag-field">
          <span>Navn</span>
          <input className="ag-inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="fx Bottles With History" autoFocus required />
        </label>
        <label className="ag-field">
          <span>Beskrivelse (valgfri)</span>
          <textarea className="ag-inp" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <p className="ag-muted">Bagefter forbinder du shoppens Shopify eller en feed-URL og opretter feeds pr. land.</p>
        {error && <p className="note warn">{error}</p>}
        <div className="ag-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose} disabled={busy}>
            Annullér
          </button>
          <button type="submit" className="wl-btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Opretter…' : 'Opret kunde'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function RenameDialog({ shop, onClose, onSaved }: { shop: AgencyShop; onClose: () => void; onSaved: (name: string) => void }) {
  const [name, setName] = useState(shop.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/projects/${shop.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    })
    if (!res.ok) {
      setError(await readError(res))
      setBusy(false)
      return
    }
    onSaved(name.trim())
  }

  return (
    <Dialog title="Omdøb kunde" onClose={onClose}>
      <form className="ag-dlg-body" onSubmit={submit}>
        <label className="ag-field">
          <span>Navn</span>
          <input className="ag-inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        {error && <p className="note warn">{error}</p>}
        <div className="ag-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose}>
            Annullér
          </button>
          <button type="submit" className="wl-btn-primary" disabled={busy || !name.trim() || name.trim() === shop.name}>
            {busy ? 'Gemmer…' : 'Gem'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function DeleteDialog({ shop, onClose, onDeleted }: { shop: AgencyShop; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    const res = await fetch(`/api/projects/${shop.id}`, { method: 'DELETE' })
    if (!res.ok) {
      setError(await readError(res))
      setBusy(false)
      return
    }
    onDeleted()
  }

  return (
    <Dialog title="Slet kunde" onClose={onClose}>
      <div className="ag-dlg-body">
        <p>
          Slet <b>{shop.name}</b>?
          {shop.feeds > 0 && (
            <>
              {' '}
              Det sletter også {shop.feeds === 1 ? 'dens feed' : `dens ${formatNumber(shop.feeds)} feeds`} og alle data i
              FeedFlow.
            </>
          )}{' '}
          Det kan ikke fortrydes. Shopify røres ikke.
        </p>
        {error && <p className="note warn">{error}</p>}
        <div className="ag-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose} disabled={busy}>
            Annullér
          </button>
          <button type="button" className="wl-btn-primary ag-danger" onClick={submit} disabled={busy}>
            {busy ? 'Sletter…' : 'Slet kunde'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
