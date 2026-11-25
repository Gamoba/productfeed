'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { refreshShell } from '@/app/components/shell/useShell'

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
      refreshShell()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not save the name')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Rename feed" onClose={onClose}>
      <form onSubmit={submit} className="dlg-body">
        <label className="dlg-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className="ff-input" required />
        </label>
        {err && <p className="neg dlg-err">{err}</p>}
        <div className="dlg-foot">
          <button type="button" onClick={onClose} className="ff-btn-secondary">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim() || name.trim() === feed.name}
            className="ff-btn-primary"
          >
            {busy ? 'Saving…' : 'Save'}
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
      setErr(e2 instanceof Error ? e2.message : 'Could not save the description')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Edit description" onClose={onClose}>
      <form onSubmit={submit} className="dlg-body">
        <label className="dlg-field">
          <span>Description</span>
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
            Cancel
          </button>
          <button type="submit" disabled={busy || !dirty} className="ff-btn-primary">
            {busy ? 'Saving…' : 'Save'}
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
      refreshShell()
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not delete the feed')
      setBusy(false)
    }
  }

  return (
    <Dialog title="Delete feed" onClose={onClose}>
      <div className="dlg-body">
        <p>
          Delete <b>{feed.name}</b>? The feed&apos;s mapping, rules and products are deleted too, and this cannot
          be undone. The shop is not affected.
        </p>
        {err && <p className="neg dlg-err">{err}</p>}
        <div className="dlg-foot">
          <button type="button" onClick={onClose} className="ff-btn-secondary" disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy} className="ff-btn-primary dlg-danger">
            {busy ? 'Deleting…' : 'Delete feed'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
