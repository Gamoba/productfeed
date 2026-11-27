'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createContext, useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgencyOverview, AgencyShop } from '@/lib/agencyOverview'
import { Icon } from '@/app/components/shell/icons'
import { Popover } from '@/app/components/shell/Popover'
import { flagEmoji, initials } from '@/app/components/shell/nav'
import { countryName, formatNumber } from '@/lib/formatDa'
import { refreshShell } from '@/app/components/shell/useShell'
import { LimitNote, readLimitError } from '@/app/components/LimitNote'
import './agency.css'

// What a row is called: an agency's rows are its customers, a customer
// account's rows are its own shops (lib/currentAccount.ts).
const NOUNS = {
  agency: { one: 'customer', many: 'customers', One: 'Customer', Many: 'Customers' },
  customer: { one: 'shop', many: 'shops', One: 'Shop', Many: 'Shops' },
} as const
const Noun = createContext<(typeof NOUNS)[keyof typeof NOUNS]>(NOUNS.agency)

export function AgencyDashboardClient({
  initial,
  account,
}: {
  initial: AgencyOverview
  /** The account the user is working in; a customer account gets its own words. */
  account: { name: string; type: 'mcc' | 'user' } | null
}) {
  const customer = account?.type === 'user'
  return (
    <Noun.Provider value={customer ? NOUNS.customer : NOUNS.agency}>
      <Dashboard initial={initial} title={customer ? 'Dashboard' : 'Agency dashboard'} lede={
        customer
          ? `All of ${account?.name ?? 'the account'}’s shops. Click a shop to open it and its feeds.`
          : 'All the customers the agency has access to. Click a customer to open the shop and its feeds.'
      } />
    </Noun.Provider>
  )
}

function Dashboard({ initial, title, lede }: { initial: AgencyOverview; title: string; lede: string }) {
  const n = useContext(Noun)
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
          <h1>{title}</h1>
          <p className="ag-lede">{lede}</p>
        </div>
        <button type="button" className="wl-btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> Create {n.one}
        </button>
      </header>

      <section className="card flush">
        <div className="ag-stats">
          <div>
            <span>{n.Many}</span>
            <strong className="num">{formatNumber(shops.length)}</strong>
            <small>
              {formatNumber(withFeeds)} with live feeds
            </small>
          </div>
          <div>
            <span>Total feeds</span>
            <strong className="num">{formatNumber(feedTotal)}</strong>
            <small>across {n.many}</small>
          </div>
          <div>
            <span>Errors needing action</span>
            <strong className={`num${errorTotal > 0 ? ' neg' : ''}`}>{formatNumber(errorTotal)}</strong>
            <small>
              {errorTotal === 0
                ? 'All feeds are ready'
                : `for ${formatNumber(shopsWithErrors)} ${shopsWithErrors === 1 ? n.one : n.many}`}
            </small>
          </div>
        </div>

        {shops.length === 0 ? (
          <div className="ag-empty">
            <p>
              No {n.many} yet. Create the first one and connect its Shopify shop or feed URL.
            </p>
            <button type="button" className="wl-btn-primary" onClick={() => setCreating(true)}>
              Create first {n.one}
            </button>
          </div>
        ) : (
          <div className="ag-tablewrap">
            <table className="ag-table">
              <thead>
                <tr>
                  <th>{n.One}</th>
                  <th>Access</th>
                  <th>Country</th>
                  <th className="r">Feeds</th>
                  <th className="r">Errors</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {shops.map((s) => (
                  <ShopRow
                    key={s.id}
                    shop={s}
                    showAccount={initial.multipleAccounts}
                    onOpen={() => router.push(openHref(s))}
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
        Errors count validation errors in feeds, plus feeds whose products have not synced for more than two days. Warnings are not included.
      </p>

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

// ── one customer ─────────────────────────────────────────────────────────────

// Where a row leads: the shop, or the one feed we were granted (decision 10).
const openHref = (shop: AgencyShop) =>
  shop.grantedFeedIds?.length ? `/feed/${shop.grantedFeedIds[0]}` : `/project/${shop.id}`

function Access({ shop }: { shop: AgencyShop }) {
  if (shop.grantedFeedIds?.length) {
    return (
      <span className="pill ai">
        {shop.grantedFeedIds.length === 1 ? 'One feed' : `${shop.grantedFeedIds.length} feeds`}
      </span>
    )
  }
  if (shop.planEnded) return <span className="neg">No active plan</span>
  if (shop.source === 'feed_url') return <span className="st">Feed URL</span>
  if (shop.connection === 'connected') return <span className="st">Shopify connected</span>
  if (shop.connection === 'error') return <span className="neg">Shopify failing</span>
  return <span className="pill warn">Not connected</span>
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
  const n = useContext(Noun)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const granted = shop.grantedFeedIds?.length ? shop.grantedFeedIds : null
  const sub = [granted ? 'Access to the feed only' : shop.address, showAccount ? shop.accountName : null]
    .filter(Boolean)
    .join(' · ')

  // A client without an active plan (none yet, or it ended): shown, but
  // there is nothing to open until they have one.
  if (shop.planEnded) {
    return (
      <tr className="ag-row-off">
        <td>
          <span className="ag-shop">
            <span className="ag-av" aria-hidden="true">
              {initials(shop.name)}
            </span>
            <span>
              <b>{shop.name}</b>
              <small>{sub || 'No source yet'}</small>
            </span>
          </span>
        </td>
        <td>
          <Access shop={shop} />
        </td>
        <td>
          <span className="ag-muted">—</span>
        </td>
        <td className="r num">
          <span className="ag-muted">—</span>
        </td>
        <td className="r num">
          <span className="ag-muted">—</span>
        </td>
        <td className="r ag-muted">Opens when {shop.accountName || 'the client'} has a plan</td>
      </tr>
    )
  }

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
            <small>{sub || 'No source yet'}</small>
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
        <Link href={openHref(shop)} className="link">
          {granted ? 'Open feed' : `Open ${n.one}`}
        </Link>
        {granted ? null : (
        <Popover
          label={`More actions for ${shop.name}`}
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
                Rename
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
                Delete {n.one}
              </button>
            </>
          )}
        </Popover>
        )}
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
  const n = useContext(Noun)
  const router = useRouter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [upgrade, setUpgrade] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setUpgrade(null)
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: description.trim() }),
    })
    if (!res.ok) {
      const r = await readLimitError(res)
      setError(r.error)
      setUpgrade(r.upgrade)
      setBusy(false)
      return
    }
    const data = (await res.json()) as { project?: { id: string } }
    // Land on the new shop, where the source is connected next.
    if (data.project?.id) router.push(`/project/${data.project.id}`)
  }

  return (
    <Dialog title={`Create ${n.one}`} onClose={onClose}>
      <form className="ag-dlg-body" onSubmit={submit}>
        <label className="ag-field">
          <span>Name</span>
          <input className="ag-inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bottles With History" autoFocus required />
        </label>
        <label className="ag-field">
          <span>Description (optional)</span>
          <textarea className="ag-inp" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <p className="ag-muted">Next, you connect the shop&apos;s Shopify or a feed URL and create feeds per country.</p>
        <LimitNote error={error} upgrade={upgrade} />
        <div className="ag-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="wl-btn-primary" disabled={busy || !name.trim()}>
            {busy ? 'Creating…' : `Create ${n.one}`}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function RenameDialog({ shop, onClose, onSaved }: { shop: AgencyShop; onClose: () => void; onSaved: (name: string) => void }) {
  const n = useContext(Noun)
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
    <Dialog title={`Rename ${n.one}`} onClose={onClose}>
      <form className="ag-dlg-body" onSubmit={submit}>
        <label className="ag-field">
          <span>Name</span>
          <input className="ag-inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        </label>
        {error && <p className="note warn">{error}</p>}
        <div className="ag-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="wl-btn-primary" disabled={busy || !name.trim() || name.trim() === shop.name}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function DeleteDialog({ shop, onClose, onDeleted }: { shop: AgencyShop; onClose: () => void; onDeleted: () => void }) {
  const n = useContext(Noun)
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
    <Dialog title={`Delete ${n.one}`} onClose={onClose}>
      <div className="ag-dlg-body">
        <p>
          Delete <b>{shop.name}</b>?
          {shop.feeds > 0 && (
            <>
              {' '}
              This also deletes {shop.feeds === 1 ? 'its feed' : `its ${formatNumber(shop.feeds)} feeds`} and all its data in
              Kompara.
            </>
          )}{' '}
          This cannot be undone. Shopify is not touched.
        </p>
        {error && <p className="note warn">{error}</p>}
        <div className="ag-dlg-foot">
          <button type="button" className="wl-btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="wl-btn-primary ag-danger" onClick={submit} disabled={busy}>
            {busy ? 'Deleting…' : `Delete ${n.one}`}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
