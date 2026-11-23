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
        `Slet gruppen “${bname}”? Varerne fjernes fra gruppen, men titler den allerede har lavet, bliver i feedet.`
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
              ? { cls: 'st st-off', label: 'Tom' }
              : b.needsReview > 0
                ? { cls: 'neg', label: `${formatNumber(b.needsReview)} venter på godkendelse` }
                : b.aiGenerated + b.humanEdited > 0
                  ? { cls: 'st', label: 'Optimeret' }
                  : { cls: 'st st-off', label: 'Kladde' }
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
                    aria-label="Nyt navn"
                  />
                  <button onClick={() => handleRename(b.id)} disabled={isPending} className="ff-btn-primary">
                    Gem
                  </button>
                  <button onClick={() => setEditingId(null)} className="ff-btn-ghost">
                    Annullér
                  </button>
                </div>
              ) : (
                <>
                  <div className="ts-bcard-top">
                    <Link href={`/feed/${feedId}/optimize/${b.id}`} className="ts-bname">
                      {b.name}
                    </Link>
                    <Popover
                      label={`Flere handlinger for ${b.name}`}
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
                            Omdøb
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
                            Slet gruppe
                          </button>
                        </>
                      )}
                    </Popover>
                  </div>
                  <p className="ts-bmeta">
                    {b.memberCount === 0
                      ? 'Ingen varer endnu. Vælg dem under Scope.'
                      : [
                          `${formatNumber(b.memberCount)} ${b.memberCount === 1 ? 'vare' : 'varer'}`,
                          b.aiGenerated > 0 ? `${formatNumber(b.aiGenerated)} optimeret` : null,
                          b.humanEdited > 0 ? `${formatNumber(b.humanEdited)} rettet i hånden` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </p>
                  <div className="ts-bfoot">
                    <span className={state.cls}>{state.label}</span>
                    <Link href={`/feed/${feedId}/optimize/${b.id}`} className="link">
                      Åbn
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
              <span>Navn på gruppen</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') setAdding(false)
                }}
                placeholder="fx Årgangsvine"
                className="ff-input"
                autoFocus
              />
            </label>
            <div className="ts-bfoot">
              <button onClick={() => setAdding(false)} className="ff-btn-ghost">
                Annullér
              </button>
              <button onClick={handleCreate} disabled={isPending || !name.trim()} className="ff-btn-primary">
                {isPending ? 'Opretter…' : 'Opret og vælg varer'}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ts-bcard ts-add" onClick={() => setAdding(true)}>
            + Ny gruppe
          </button>
        )}
      </div>

      {list.length === 0 && !adding && (
        <p className="ts-hint">
          Ingen grupper endnu. En gruppe samler varer, der skal have titler i samme stil, fx årgangsvine eller
          gaveæsker.
        </p>
      )}
    </div>
  )
}
