'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'

// Rename, edit description and delete for one feed. Used from the row menu on
// the shop's Feeds page.

export type PatchedFeed = { id: string; name: string; description: string | null }
type FeedRef = { id: string; name: string; description: string | null }

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  // Portalled to <body> so no ancestor (a table row, an animated page) can clip
  // or contain the fixed backdrop.
  return createPortal(
    <div className="dlg-overlay" onClick={onClose}>
      <div
        className="dlg"
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

async function patchFeed(feedId: string, body: { name?: string; description?: string }): Promise<PatchedFeed> {
  const res = await fetch(`/api/feeds/${feedId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as { feed?: PatchedFeed; error?: string }
  if (!res.ok || data.error || !data.feed) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data.feed
}

export function RenameFeedDialog({
  feed,
  onClose,
  onSaved,
}: {
  feed: FeedRef
  onClose: () => void
  onSaved: (updated: PatchedFeed) => void
}) {
  const [name, setName] = useState(feed.name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setErr(null)
    try {
      onSaved(await patchFeed(feed.id, { name: trimmed }))
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Navnet kunne ikke gemmes')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Omdøb feed" onClose={onClose}>
      <form onSubmit={submit} className="dlg-body">
        <label className="dlg-field">
          <span>Navn</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="ff-input" required />
        </label>
        {err && <p className="neg dlg-err">{err}</p>}
        <div className="dlg-foot">
          <button type="button" onClick={onClose} className="ff-btn-secondary">
            Annullér
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || name.trim() === feed.name}
            className="ff-btn-primary"
          >
            {busy ? 'Gemmer…' : 'Gem'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function DescribeFeedDialog({
  feed,
  onClose,
  onSaved,
}: {
  feed: FeedRef
  onClose: () => void
  onSaved: (updated: PatchedFeed) => void
}) {
  const [description, setDescription] = useState(feed.description ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = description.trim() !== (feed.description ?? '').trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      onSaved(await patchFeed(feed.id, { description }))
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Beskrivelsen kunne ikke gemmes')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Rediger beskrivelse" onClose={onClose}>
      <form onSubmit={submit} className="dlg-body">
        <label className="dlg-field">
          <span>Beskrivelse</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            autoFocus
            className="ff-input"
            style={{ resize: 'none' }}
          />
        </label>
        {err && <p className="neg dlg-err">{err}</p>}
        <div className="dlg-foot">
          <button type="button" onClick={onClose} className="ff-btn-secondary">
            Annullér
          </button>
          <button type="submit" disabled={busy || !dirty} className="ff-btn-primary">
            {busy ? 'Gemmer…' : 'Gem'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function DeleteFeedDialog({
  feed,
  onClose,
  onDeleted,
}: {
  feed: FeedRef
  onClose: () => void
  onDeleted: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(`/api/feeds/${feed.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      onDeleted()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Feedet kunne ikke slettes')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Slet feed" onClose={onClose}>
      <div className="dlg-body">
        <p>
          Vil du slette <b>{feed.name}</b>? Mapping, regler og varer i feedet slettes også, og det kan
          ikke fortrydes. Shoppen påvirkes ikke.
        </p>
        {err && <p className="neg dlg-err">{err}</p>}
        <div className="dlg-foot">
          <button type="button" onClick={onClose} className="ff-btn-secondary" disabled={busy}>
            Annullér
          </button>
          <button type="button" onClick={submit} disabled={busy} className="ff-btn-primary dlg-danger">
            {busy ? 'Sletter…' : 'Slet feed'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
