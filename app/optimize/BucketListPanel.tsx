'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createBucket, renameBucket, deleteBucket } from './actions'
import type { BucketSummary } from '@/lib/optimizationBuckets'
import { Popover } from '@/app/components/shell/Popover'
import { formatNumber } from '@/lib/formatDa'

// Step 1: the buckets as cards, plus a card to make a new one.
export function BucketListPanel({
  feedId,
  initialBuckets,
}: {
  feedId: string
  initialBuckets: BucketSummary[]
}) {
  const router = useRouter()
  const [list, setList] = useState<BucketSummary[]>(initialBuckets)
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleCreate() {
    setError(null)
    if (!name.trim()) return
    startTransition(async () => {
      // Every bucket runs the workshop path (instructions + examples + input
      // fields); 'auto' is the default method.
      const r = await createBucket(feedId, name.trim(), 'auto')
      if ('error' in r) setError(r.error)
      // Straight into the new bucket's Scope step.
      else router.push(`/feed/${feedId}/optimize/${r.data.id}`)
    })
  }

  function handleRename(id: string) {
    setError(null)
    if (!editName.trim()) {
      setEditingId(null)
      return
    }
    startTransition(async () => {
      const r = await renameBucket(feedId, id, editName.trim())
      if (r.error) setError(r.error)
      else {
        setList((prev) => prev.map((b) => (b.id === id ? { ...b, name: editName.trim() } : b)))
        setEditingId(null)
      }
    })
  }

  function handleDelete(id: string, bname: string) {
    setError(null)
    if (
      !confirm(
        `Delete the bucket “${bname}”? Its products are removed from the bucket, but titles it has already made stay in the feed.`
      )
    )
      return
    startTransition(async () => {
      const r = await deleteBucket(feedId, id)
      if (r.error) setError(r.error)
      else setList((prev) => prev.filter((b) => b.id !== id))
    })
  }

  return (
    <div className="ts-buckets">
      {error && <p className="note warn">{error}</p>}

      <div className="ts-bgrid">
        {list.map((b) => {
          const state =
            b.memberCount === 0
              ? { cls: 'st st-off', label: 'Empty' }
              : b.needsReview > 0
                ? { cls: 'neg', label: `${formatNumber(b.needsReview)} awaiting review` }
                : b.aiGenerated + b.humanEdited > 0
                  ? { cls: 'st', label: 'Optimised' }
                  : { cls: 'st st-off', label: 'Draft' }
          return (
            <div key={b.id} className="ts-bcard">
              {editingId === b.id ? (
                <div className="ts-rename">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(b.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    autoFocus
                    className="ff-input"
                    aria-label="New name"
                  />
                  <button onClick={() => handleRename(b.id)} disabled={isPending} className="ff-btn-primary">
                    Save
                  </button>
                  <button onClick={() => setEditingId(null)} className="ff-btn-ghost">
                    Cancel
                  </button>
                </div>
              ) : (
                <>
                  <div className="ts-bcard-top">
                    <Link href={`/feed/${feedId}/optimize/${b.id}`} className="ts-bname">
                      {b.name}
                    </Link>
                    <Popover
                      label={`More actions for ${b.name}`}
                      align="right"
                      triggerClassName="ts-more"
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
                              setEditingId(b.id)
                              setEditName(b.name)
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
                              handleDelete(b.id, b.name)
                            }}
                          >
                            Delete bucket
                          </button>
                        </>
                      )}
                    </Popover>
                  </div>
                  <p className="ts-bmeta">
                    {b.memberCount === 0
                      ? 'No products yet. Choose them under Scope.'
                      : [
                          `${formatNumber(b.memberCount)} ${b.memberCount === 1 ? 'product' : 'products'}`,
                          b.aiGenerated > 0 ? `${formatNumber(b.aiGenerated)} optimised` : null,
                          b.humanEdited > 0 ? `${formatNumber(b.humanEdited)} edited by hand` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </p>
                  <div className="ts-bfoot">
                    <span className={state.cls}>{state.label}</span>
                    <Link href={`/feed/${feedId}/optimize/${b.id}`} className="link">
                      Open
                    </Link>
                  </div>
                </>
              )}
            </div>
          )
        })}

        {adding ? (
          <div className="ts-bcard ts-new">
            <label className="ts-field">
              <span>Bucket name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') setAdding(false)
                }}
                placeholder="e.g. Vintage wines"
                className="ff-input"
                autoFocus
              />
            </label>
            <div className="ts-bfoot">
              <button onClick={() => setAdding(false)} className="ff-btn-ghost">
                Cancel
              </button>
              <button onClick={handleCreate} disabled={isPending || !name.trim()} className="ff-btn-primary">
                {isPending ? 'Creating…' : 'Create and choose products'}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ts-bcard ts-add" onClick={() => setAdding(true)}>
            + New bucket
          </button>
        )}
      </div>

      {list.length === 0 && !adding && (
        <p className="ts-hint">
          No buckets yet. A bucket groups products that should have titles in the same style, e.g. vintage wines
          or gift boxes.
        </p>
      )}
    </div>
  )
}
