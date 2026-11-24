'use client'

// Unified Results view — every product in the bucket with its original vs. new
// title side by side, status, and inline editing. Replaces the old Review tab:
// needs_review work happens here via the status filter + per-row Approve/Reject.
//
// Inline edit: change the title field → ✓ (save → human_edited) / ✕ (revert).
// needs_review rows also get an explicit Approve (save the proposal as-is) and
// Reject (lock to original). Already-optimized rows get Reject as "revert to
// original". Expanding a row lazy-loads its read-only product data.

import { useEffect, useState } from 'react'
import { listBucketResults, getBucketProductDetail, saveBucketReviewTitle, rejectBucketReview } from './actions'
import type { ResultItem, ResultStatus, ProductDetail } from '@/lib/titleOptimizationService'

const STATUS_META: Record<ResultStatus, { label: string; badge: string }> = {
  ai_generated: { label: 'Optimised', badge: 'ff-badge-success' },
  human_edited: { label: 'Edited by hand', badge: 'ff-badge-accent' },
  needs_review: { label: 'Awaiting review', badge: 'ff-badge-warning' },
  not_optimized: { label: 'Not optimised', badge: 'ff-badge-neutral' },
}

const FILTERS: { id: ResultStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs_review', label: 'Awaiting review' },
  { id: 'not_optimized', label: 'Not optimised' },
  { id: 'ai_generated', label: 'Optimised' },
  { id: 'human_edited', label: 'Edited by hand' },
]

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// Row thumbnail — same treatment as the Products tab (fixed square, rounded,
// bordered). Placeholder square when the product has no image.
// ~72px (roughly double the Products-tab thumbnail) — explicit px so it doesn't
// depend on a non-standard Tailwind size class.
const ROW_IMG = 72
function RowImage({ url, alt }: { url: string | null; alt: string }) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={alt}
        loading="lazy"
        className="object-cover shrink-0"
        style={{ width: ROW_IMG, height: ROW_IMG, borderRadius: '6px', border: '1px solid var(--hairline)' }}
      />
    )
  }
  return (
    <div
      className="shrink-0"
      style={{ width: ROW_IMG, height: ROW_IMG, background: 'var(--bg-surface)', borderRadius: '6px' }}
    />
  )
}

// Expand chevron — mirrors the Products tab (rotates 180° when open).
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      style={{ color: 'var(--ink-muted)' }}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

// Expanded-detail helpers — same visual language as the Products tab's detail.
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="ff-label" style={{ marginBottom: '6px', fontWeight: 600, color: 'var(--ink)' }}>
      {children}
    </h4>
  )
}
function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start">
      <span style={{ fontSize: '11px', color: 'var(--ink-muted)', width: '130px', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '11px', color: 'var(--ink)', flex: 1, minWidth: 0 }} className="break-words">
        {children}
      </span>
    </div>
  )
}

export function BucketResultsPanel({
  feedId,
  bucketId,
  reloadKey,
  isActive = true,
}: {
  feedId: string
  bucketId: string
  reloadKey: number
  // True while the Run step (which hosts Results) is active. Tabs stay mounted, so
  // we re-read results each time this becomes active rather than only on mount —
  // otherwise Results shows a stale page-load snapshot on entry.
  isActive?: boolean
}) {
  const [items, setItems] = useState<ResultItem[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ResultStatus | 'all'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, ProductDetail | 'loading'>>({})

  // (Re)load results each time this becomes active, plus on reloadKey bumps (after a
  // run). Updates in place — no setLoading(true) on re-entry, so no flicker and no
  // synchronous setState in the effect body.
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    listBucketResults(feedId, bucketId).then((r) => {
      if (cancelled) return
      if ('data' in r) {
        setItems(r.data)
        setDrafts(Object.fromEntries(r.data.map((i) => [i.product_ref, i.new_title ?? ''])))
      } else setError(r.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId, reloadKey, isActive])

  // Apply a server result locally so the row reflects the new state without a full reload.
  function applyLocal(ref: string, patch: Partial<ResultItem>) {
    setItems((prev) => prev.map((i) => (i.product_ref === ref ? { ...i, ...patch } : i)))
    if (patch.new_title !== undefined) {
      setDrafts((p) => ({ ...p, [ref]: patch.new_title ?? '' }))
    }
  }

  async function saveTitle(ref: string, title: string) {
    const trimmed = title.trim()
    if (!trimmed) {
      setError('Title cannot be empty')
      return
    }
    setError(null)
    setBusy(ref)
    const r = await saveBucketReviewTitle(feedId, bucketId, ref, trimmed)
    if (r.error) setError(r.error)
    else applyLocal(ref, { new_title: trimmed, status: 'human_edited', validation_issues: [] })
    setBusy(null)
  }

  async function reject(ref: string) {
    setError(null)
    setBusy(ref)
    const r = await rejectBucketReview(feedId, bucketId, ref)
    if (r.error) setError(r.error)
    else {
      const original = items.find((i) => i.product_ref === ref)?.original_title ?? ''
      applyLocal(ref, { new_title: original, status: 'human_edited', validation_issues: [] })
    }
    setBusy(null)
  }

  function toggleExpand(ref: string) {
    if (expanded === ref) {
      setExpanded(null)
      return
    }
    setExpanded(ref)
    if (!details[ref]) {
      setDetails((p) => ({ ...p, [ref]: 'loading' }))
      getBucketProductDetail(feedId, bucketId, ref).then((r) => {
        setDetails((p) => ({ ...p, [ref]: 'data' in r ? r.data : 'loading' }))
        if ('error' in r) setError(r.error)
      })
    }
  }

  const counts = items.reduce(
    (acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }),
    {} as Record<string, number>
  )
  const shown = filter === 'all' ? items : items.filter((i) => i.status === filter)

  if (loading) return <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>Loading results…</p>

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span style={{ fontSize: '16px', fontWeight: 500, color: 'var(--ink)' }}>
          Results <span style={{ color: 'var(--ink-muted)', fontWeight: 400 }}>· {items.length.toLocaleString('en-GB')} {items.length === 1 ? 'product' : 'products'}</span>
        </span>
        {error && <span style={{ fontSize: '11px', color: 'var(--accent-red)' }}>{error}</span>}
      </div>

        {/* Status filter */}
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => {
            const n = f.id === 'all' ? items.length : counts[f.id] ?? 0
            const active = filter === f.id
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                style={{
                  padding: '3px 10px',
                  fontSize: '11px',
                  borderRadius: '5px',
                  border: '1px solid var(--hairline)',
                  background: active ? 'var(--accent-ink)' : 'transparent',
                  color: active ? '#ffffff' : 'var(--ink-secondary)',
                }}
              >
                {f.label} {n > 0 && <span style={{ opacity: 0.7 }}>({n.toLocaleString('en-GB')})</span>}
              </button>
            )
          })}
        </div>

        {shown.length === 0 ? (
          <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>No products in this view.</p>
        ) : (
          <div className="space-y-1.5">
            {shown.map((it) => {
              const meta = STATUS_META[it.status]
              const draft = drafts[it.product_ref] ?? ''
              const baseline = it.new_title ?? ''
              const dirty = draft.trim() !== baseline.trim()
              const rowBusy = busy === it.product_ref
              const hasRow = it.status !== 'not_optimized'
              const isOpen = expanded === it.product_ref
              const detail = details[it.product_ref]
              return (
                <div key={it.product_ref} className="ff-panel">
                  {/* Row header — same card layout as the Products tab */}
                  <div
                    className="flex items-start gap-3 px-3.5 py-2"
                    style={{ background: isOpen ? 'var(--bg-surface)' : 'transparent' }}
                  >
                    <RowImage url={it.image_url} alt={it.original_title} />

                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`shrink-0 ff-badge ${meta.badge}`}>{meta.label}</span>
                      </div>

                      {/* New title — editable, with inline ✓/✕ when changed */}
                      <div className="flex items-center gap-1.5">
                        <input
                          value={draft}
                          onChange={(e) => setDrafts((p) => ({ ...p, [it.product_ref]: e.target.value }))}
                          placeholder={it.status === 'not_optimized' ? 'No title yet. Write one to save' : ''}
                          className="ff-input flex-1 min-w-0"
                          style={{ fontSize: '12px' }}
                          aria-label="New title"
                        />
                        {dirty && (
                          <>
                            <button
                              type="button"
                              onClick={() => saveTitle(it.product_ref, draft)}
                              disabled={rowBusy || !draft.trim()}
                              className="ff-btn-ghost shrink-0 w-6 h-6 flex items-center justify-center"
                              style={{ color: 'var(--good)' }}
                              aria-label="Save title"
                              title="Save"
                            >
                              <CheckIcon />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDrafts((p) => ({ ...p, [it.product_ref]: baseline }))}
                              disabled={rowBusy}
                              className="ff-btn-ghost shrink-0 w-6 h-6 flex items-center justify-center"
                              style={{ color: 'var(--ink-muted)' }}
                              aria-label="Cancel change"
                              title="Cancel"
                            >
                              <XIcon />
                            </button>
                          </>
                        )}
                      </div>

                      {/* Original title (read-only) */}
                      <div className="truncate" style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>
                        Original: {it.original_title || '—'}
                      </div>

                      {/* needs_review: why it failed */}
                      {it.status === 'needs_review' && it.validation_issues.length > 0 && (
                        <div style={{ fontSize: '10px', color: 'var(--accent-amber)' }}>
                          {it.validation_issues.map((iss, idx) => (
                            <div key={idx}>• {iss.detail}</div>
                          ))}
                        </div>
                      )}

                      {/* Row actions */}
                      <div className="flex items-center gap-2 pt-0.5">
                        {it.status === 'needs_review' && (
                          <button
                            type="button"
                            onClick={() => saveTitle(it.product_ref, baseline)}
                            disabled={rowBusy || !baseline.trim()}
                            className="ff-btn-secondary"
                            style={{ fontSize: '11px' }}
                          >
                            Approve
                          </button>
                        )}
                        {hasRow && (
                          <button
                            type="button"
                            onClick={() => reject(it.product_ref)}
                            disabled={rowBusy}
                            className="ff-btn-ghost"
                            style={{ fontSize: '11px', padding: '0 8px', color: 'var(--accent-red)' }}
                            title="Go back to the original title from Shopify"
                          >
                            Reject
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Expand chevron — right side, like the Products tab */}
                    <button
                      type="button"
                      onClick={() => toggleExpand(it.product_ref)}
                      className="shrink-0 self-center cursor-pointer flex items-center justify-center"
                      style={{ width: '24px', height: '24px', background: 'transparent', border: 'none' }}
                      aria-label={isOpen ? 'Collapse' : 'Expand product'}
                      title="Show product data"
                    >
                      <ChevronIcon open={isOpen} />
                    </button>
                  </div>

                  {/* Expandable detail — same fold-out pattern as the Products tab */}
                  {isOpen && (
                    <div className="px-3.5 py-3 space-y-4" style={{ borderTop: '1px solid var(--hairline)' }}>
                      {detail === 'loading' || detail === undefined ? (
                        <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>Loading product data…</p>
                      ) : (
                        <>
                          <section>
                            <SectionHeader>Optimisation</SectionHeader>
                            <div className="space-y-1.5">
                              <InfoRow label="Status">
                                <span className={`ff-badge ${meta.badge}`}>{meta.label}</span>
                              </InfoRow>
                              <InfoRow label="Original title">{it.original_title || '—'}</InfoRow>
                              <InfoRow label="New title">{it.new_title || '—'}</InfoRow>
                              {detail.validation_issues.length > 0 && (
                                <InfoRow label="Validation">
                                  <span style={{ color: 'var(--accent-amber)' }}>
                                    {detail.validation_issues.map((iss) => iss.detail).join('; ')}
                                  </span>
                                </InfoRow>
                              )}
                            </div>
                          </section>

                          <section>
                            <SectionHeader>Product data</SectionHeader>
                            {detail.fields.length === 0 ? (
                              <span style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
                                The product has no structured fields.
                              </span>
                            ) : (
                              <div className="space-y-1.5">
                                {detail.fields.map((f) => (
                                  <InfoRow key={f.token} label={f.label}>
                                    {f.value}
                                  </InfoRow>
                                ))}
                              </div>
                            )}
                          </section>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}
