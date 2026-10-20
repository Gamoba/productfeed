'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import {
  BUCKET_METRICS,
  orderBuckets,
  type Bucket,
  type BucketLevel,
  type BucketMetric,
  type BucketOperator,
  type BucketRule,
  type CustomLabel,
} from '@/lib/googleAdsBuckets'

export type LabelView = {
  label: CustomLabel
  buckets: Bucket[]
  counts: Record<string, number>
  assigned: number
  stale: { never: boolean; dataNewer: boolean; settingsNewer: boolean }
}

export type PreviewRow = {
  ref: string
  productRef: string | null
  title: string | null
  cells: Record<string, { name: string; value: string }>
}

export type PreviewTable = {
  level: BucketLevel
  labelIds: string[]
  rows: PreviewRow[]
  total: number
}

type Props = {
  feedId: string
  feedName: string
  connected: boolean
  currency: string | null
  roasActions: string[]
  poasActions: string[]
  labels: LabelView[]
  tables: PreviewTable[]
}

const METRIC_LABEL: Record<BucketMetric, string> = {
  roas: 'ROAS',
  poas: 'POAS',
  conversions: 'Conversions (account default)',
  roas_conversions: 'Conversions (revenue)',
  poas_conversions: 'Conversions (gross profit)',
  conversions_value: 'Revenue',
  cost: 'Cost',
  clicks: 'Clicks',
  impressions: 'Impressions',
  profit_after_ad_spend: 'Profit − cost',
  cogs_margin: 'Margin (COGS)',
  inventory_quantity: 'Stock (units)',
  stock_coverage: 'Stock coverage',
  days_of_stock: 'Days of stock',
}

const OPERATORS: { value: BucketOperator; label: string; needsValue: boolean }[] = [
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '≥', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '≤', needsValue: true },
  { value: 'eq', label: '=', needsValue: true },
  { value: 'neq', label: '≠', needsValue: true },
  { value: 'is_empty', label: 'has no value', needsValue: false },
  { value: 'is_not_empty', label: 'has a value', needsValue: false },
]

const WINDOWS = [7, 14, 30, 90, 180, 365]
const SLOTS = [0, 1, 2, 3, 4]

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[æä]/g, 'ae')
    .replace(/[øö]/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

export function LabelsClient(props: Props) {
  const { feedId, feedName, connected, roasActions, poasActions, labels, tables } = props

  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const [labelDraft, setLabelDraft] = useState<Record<string, CustomLabel>>({})
  const [bucketDraft, setBucketDraft] = useState<Record<string, Bucket>>({})

  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set())
  const [ghosts, setGhosts] = useState<Bucket[]>([])

  const liveIds = new Set(labels.flatMap((v) => v.buckets.map((b) => b.id)))
  const arrived = new Set(labels.flatMap((v) => v.buckets.map((b) => `${b.label_id}:${b.name}`)))
  const hiding = new Set([...pendingDelete].filter((id) => liveIds.has(id)))
  const pendingNew = ghosts.filter((g) => !arrived.has(`${g.label_id}:${g.name}`))

  const [noticesOpen, setNoticesOpen] = useState(false)

  const [newLabel, setNewLabel] = useState<string | null>(null)
  const [newBucket, setNewBucket] = useState<{
    labelId: string
    name: string
    value: string
    touched: boolean
    fallback: boolean
  } | null>(null)

  const editedLabel = (l: CustomLabel) => labelDraft[l.id] ?? l
  const editedBucket = (b: Bucket) => bucketDraft[b.id] ?? b
  const labelDirty = (l: CustomLabel) => !!labelDraft[l.id]
  const bucketDirty = (b: Bucket) => !!bucketDraft[b.id]

  const takenSlots = new Set(
    labels.map((v) => editedLabel(v.label).slot).filter((s): s is number => s !== null)
  )

  function patchLabel(l: CustomLabel, change: Partial<CustomLabel>) {
    setLabelDraft((d) => ({ ...d, [l.id]: { ...editedLabel(l), ...change } }))
  }
  function patchBucket(b: Bucket, change: Partial<Bucket>) {
    setBucketDraft((d) => ({ ...d, [b.id]: { ...editedBucket(b), ...change } }))
  }

  async function call(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
    const res = await fetch(url, init)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError((json as { error?: string }).error ?? 'Something went wrong')
      return null
    }
    return json as Record<string, unknown>
  }

  const post = (url: string, body: unknown) =>
    call(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  // ── Recompute ──────────────────────────────────────────────────────────────

  async function recompute(labelId?: string) {
    setBusy(labelId ? `recompute:${labelId}` : 'recompute')
    setError(null)
    const json = await post(`/api/google-ads/${feedId}/labels/recompute`, labelId ? { labelId } : {})
    setBusy(null)

    if (json) {
      const r = json.result as {
        labels: { name: string; assigned: number; entities: number; moved: number; unlabelled: number; warnings: string[] }[]
        warnings: string[]
      }
      const per = r.labels ?? []
      setNote(
        per.length === 1
          ? `${per[0].name}: ${per[0].assigned} of ${per[0].entities} labelled · ${per[0].moved} changed value`
          : `${per.length} labels recomputed · ${per.reduce((n, l) => n + l.moved, 0)} values changed`
      )
      const next = [
        ...(r.warnings ?? []),
        ...per.flatMap((l) => l.warnings.map((w) => `${l.name}: ${w}`)),
      ]
      setWarnings(next)
      if (next.length) setNoticesOpen(true)
    }
    router.refresh()
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  async function saveLabel(view: LabelView) {
    const before = view.label
    const after = editedLabel(before)
    setBusy(before.id)
    setError(null)
    const ok = await post(`/api/google-ads/${feedId}/labels`, { action: 'save', label: after })
    setBusy(null)
    if (!ok) return

    setLabelDraft((d) => {
      const next = { ...d }
      delete next[before.id]
      return next
    })
    if (before.level !== after.level || before.window_days !== after.window_days) {
      await recompute(before.id)
    } else {
      setNote('Saved. Nothing about what is measured changed, so nothing was recomputed.')
      router.refresh()
    }
  }

  async function addLabel(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy('add-label')
    setError(null)
    const ok = await post(`/api/google-ads/${feedId}/labels`, {
      action: 'save',
      label: { name: trimmed, slot: null, level: 'product', window_days: 30 },
    })
    setBusy(null)
    if (ok) {
      setNewLabel(null)
      router.refresh()
    }
  }

  async function removeLabel(view: LabelView) {
    setBusy(view.label.id)
    setError(null)
    const ok = await call(`/api/google-ads/${feedId}/labels?id=${view.label.id}`, { method: 'DELETE' })
    setBusy(null)
    if (ok) router.refresh()
  }

  // ── Buckets ────────────────────────────────────────────────────────────────

  async function saveBucket(b: Bucket) {
    const after = editedBucket(b)
    setBusy(b.id)
    setError(null)
    const ok = await post(`/api/google-ads/${feedId}/buckets`, { bucket: after })
    setBusy(null)
    if (!ok) return

    setBucketDraft((d) => {
      const next = { ...d }
      delete next[b.id]
      return next
    })
    const moves =
      b.priority !== after.priority ||
      b.match_type !== after.match_type ||
      b.is_fallback !== after.is_fallback ||
      rulesKey(b.rules) !== rulesKey(after.rules)

    if (moves) {
      await recompute(b.label_id)
    } else {
      setNote('Saved. No condition changed, so nothing was recomputed.')
      router.refresh()
    }
  }

  async function addBucket() {
    if (!newBucket) return
    const { labelId, name, value, fallback } = newBucket
    if (!name.trim() || !value.trim()) return

    setError(null)
    const siblings = labels.find((v) => v.label.id === labelId)?.buckets ?? []
    const nextPriority = Math.max(0, ...siblings.filter((b) => !b.is_fallback).map((b) => b.priority)) + 10

    const bucket = {
      label_id: labelId,
      name: name.trim(),
      value: value.trim(),
      priority: fallback ? 999 : nextPriority,
      match_type: 'ALL' as const,
      is_fallback: fallback,
      rules: [] as BucketRule[],
    }

    const ghostId = `${GHOST_PREFIX}${labelId}:${bucket.name}`
    setGhosts((g) => [...g, { ...bucket, id: ghostId, feed_id: '', description: null }])
    setNewBucket(null)

    const ok = await post(`/api/google-ads/${feedId}/buckets`, { bucket })

    if (!ok) {
      setGhosts((g) => g.filter((x) => x.id !== ghostId))
      setNewBucket({ labelId, name, value, touched: true, fallback })
      return
    }

    if (fallback) await recompute(labelId)
    else router.refresh()
  }

  async function removeBucket(b: Bucket) {
    setError(null)
    setPendingDelete((s) => new Set(s).add(b.id))

    const ok = await call(`/api/google-ads/${feedId}/buckets?id=${b.id}`, { method: 'DELETE' })
    if (!ok) {
      setPendingDelete((s) => {
        const next = new Set(s)
        next.delete(b.id)
        return next
      })
      return
    }
    await recompute(b.label_id)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <Shell feedName={feedName}>
        <div className="wl-card" style={{ padding: '40px' }}>
          <div className="max-w-xl space-y-3">
            <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--ink)' }}>
              Not connected to Google Ads
            </h2>
            <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink-secondary)' }}>
              Custom labels segment products by how they perform, so this feed needs a Google Ads
              connection and at least one sync first.
            </p>
            <Link href={`/feed/${feedId}/google-ads`} className="wl-btn-primary inline-block">
              Go to Performance →
            </Link>
          </div>
        </div>
      </Shell>
    )
  }

  const overlay = (v: LabelView): LabelView => {
    const kept = v.buckets.filter((b) => !hiding.has(b.id))
    const mine = pendingNew.filter((g) => g.label_id === v.label.id)
    if (kept.length === v.buckets.length && !mine.length) return v
    return { ...v, buckets: orderBuckets([...kept, ...mine]) }
  }

  const shared = roasActions.filter((a) => poasActions.includes(a))
  const sameAction =
    shared.length > 0 && shared.length === roasActions.length && shared.length === poasActions.length

  const slotted = labels.filter((v) => v.label.slot !== null).length

  const notices: Notice[] = [
    ...warnings.map((w, i) => ({ id: `w${i}`, tone: 'amber' as const, body: w })),
    ...(sameAction
      ? [
          {
            id: 'same-action',
            tone: 'amber' as const,
            body: (
              <>
                Revenue and gross profit use the same conversion action
                {roasActions.length > 1 ? 's' : ''} ({roasActions.join(', ')}), so POAS equals ROAS
                and any POAS rule is really a ROAS rule. Fix it on the Performance page.
              </>
            ),
          },
        ]
      : []),
    {
      id: 'not-published',
      tone: 'green' as const,
      body: 'Labels are computed and shown here only. Nothing is written to the product feed and nothing is sent to Merchant Center.',
    },
  ]

  return (
    <Shell feedName={feedName}>
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="space-y-1.5">
          <div className="wl-eyebrow truncate">{feedName}</div>
          <h1
            style={{
              fontSize: '34px',
              fontWeight: 500,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
            }}
          >
            Custom labels
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            {labels.length} {labels.length === 1 ? 'label' : 'labels'} · {slotted} of 5 slots in use
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/feed/${feedId}/google-ads`} className="wl-btn-secondary">
            Performance
          </Link>
          {labels.length > 0 && (
            <button onClick={() => recompute()} disabled={busy === 'recompute'} className="wl-btn-primary">
              {busy === 'recompute' ? 'Computing…' : 'Recompute all'}
            </button>
          )}
        </div>
      </header>

      {error && <Banner tone="red">{error}</Banner>}
      {note && !error && <Banner tone="green">{note}</Banner>}

      <Notices open={noticesOpen} onToggle={() => setNoticesOpen((v) => !v)} items={notices} />

      {labels.length === 0 ? (
        <div className="wl-card py-16 flex flex-col items-center gap-3">
          <p style={{ fontSize: '15px', color: 'var(--ink-secondary)' }}>No custom labels yet.</p>
          {newLabel !== null ? (
            <div className="mt-1 w-full max-w-md space-y-2.5 px-6">
              <NameField
                value={newLabel}
                placeholder="e.g. Performance"
                onChange={setNewLabel}
                onCreate={() => addLabel(newLabel)}
                onCancel={() => setNewLabel(null)}
                busy={busy === 'add-label'}
                centred
              />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 mt-1">
              <div className="flex gap-2">
                <button onClick={() => setNewLabel('')} className="wl-btn-primary">
                  Start empty
                </button>
                <button
                  disabled
                  className="wl-btn-secondary"
                  title="Templates are being written"
                >
                  Use suggested set
                </button>
              </div>
              <p style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
                Suggested sets arrive once the templates are written.
              </p>
            </div>
          )}
        </div>
      ) : (
        <section className="space-y-6">
          {labels.map((view) => (
            <LabelCard
              key={view.label.id}
              view={overlay(view)}
              edited={editedLabel(view.label)}
              dirty={labelDirty(view.label)}
              busy={busy}
              takenSlots={takenSlots}
              bucketDraft={bucketDraft}
              newBucket={newBucket}
              onPatch={(change) => patchLabel(view.label, change)}
              onSave={() => saveLabel(view)}
              onDelete={() => removeLabel(view)}
              onRecompute={() => recompute(view.label.id)}
              onPatchBucket={patchBucket}
              onSaveBucket={saveBucket}
              onDeleteBucket={removeBucket}
              bucketIsDirty={bucketDirty}
              onCompose={(fallback) =>
                setNewBucket({
                  labelId: view.label.id,
                  name: fallback ? 'Everything else' : '',
                  value: fallback ? 'other' : '',
                  touched: fallback,
                  fallback,
                })
              }
              onComposeChange={setNewBucket}
              onComposeCancel={() => setNewBucket(null)}
              onComposeCreate={addBucket}
            />
          ))}

          {newLabel !== null ? (
            <div className="wl-card" style={{ padding: '16px 18px' }}>
              <div className="wl-eyebrow">New custom label</div>
              <div style={{ marginTop: '10px' }}>
                <NameField
                  value={newLabel}
                  placeholder="e.g. Margin band"
                  onChange={setNewLabel}
                  onCreate={() => addLabel(newLabel)}
                  onCancel={() => setNewLabel(null)}
                  busy={busy === 'add-label'}
                />
              </div>
            </div>
          ) : (
            <button onClick={() => setNewLabel('')} className="wl-btn-secondary">
              + Add custom label
            </button>
          )}
        </section>
      )}

      {/* ── Verification tables ───────────────────────────────────── */}
      {tables.map((t) => (
        <PreviewSection key={t.level} table={t} labels={labels} />
      ))}
    </Shell>
  )
}

const rulesKey = (rules: BucketRule[] = []) =>
  rules.map((r) => `${r.metric}|${r.operator}|${r.value ?? ''}|${r.windowDays ?? ''}`).join(';')

const GHOST_PREFIX = 'ghost:'
const isGhost = (id: string) => id.startsWith(GHOST_PREFIX)

function GhostBlock({ bucket }: { bucket: Bucket }) {
  return (
    <div
      style={{
        border: '1px dashed var(--hairline)',
        borderRadius: '10px',
        padding: '12px 14px',
        background: 'var(--bg-base)',
        opacity: 0.6,
      }}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="wl-pill" style={{ background: 'var(--bg-surface)', color: 'var(--ink-muted)' }}>
          {bucket.is_fallback ? 'last' : bucket.priority}
        </span>
        <span style={{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>{bucket.name}</span>
        <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>emits</span>
        <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', color: 'var(--ink)' }}>
          {bucket.value}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--ink-muted)', marginLeft: 'auto' }}>Creating…</span>
      </div>
    </div>
  )
}

const miniInput: React.CSSProperties = {
  padding: '5px 8px',
  borderRadius: '8px',
  border: '1px solid var(--hairline)',
  background: 'var(--bg-base)',
  color: 'var(--ink)',
  fontSize: '12px',
}

function Shell({ feedName, children }: { feedName: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <main className="max-w-6xl mx-auto px-6 py-9 space-y-6">
        <span className="sr-only">{feedName}</span>
        {children}
      </main>
    </div>
  )
}

type Notice = { id: string; tone: 'amber' | 'green'; body: React.ReactNode }

function Notices({
  items,
  open,
  onToggle,
}: {
  items: Notice[]
  open: boolean
  onToggle: () => void
}) {
  if (!items.length) return null

  const warnings = items.filter((i) => i.tone === 'amber').length
  const summary = warnings
    ? `${warnings} warning${warnings === 1 ? '' : 's'}${items.length > warnings ? ` · ${items.length - warnings} note${items.length - warnings === 1 ? '' : 's'}` : ''}`
    : `${items.length} note${items.length === 1 ? '' : 's'}`

  return (
    <div className="wl-card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '12px 18px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span className="flex items-center gap-2.5">
          <span
            className="wl-dot"
            style={{ background: warnings ? 'var(--accent-amber)' : 'var(--accent-green)' }}
          />
          <span style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>{summary}</span>
        </span>
        <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>{open ? 'Hide' : 'Show'}</span>
      </button>

      {open &&
        items.map((i) => (
          <div
            key={i.id}
            className="flex items-start gap-2.5"
            style={{ padding: '12px 18px', borderTop: '1px solid var(--hairline)' }}
          >
            <span
              className="wl-dot shrink-0"
              style={{
                background: i.tone === 'amber' ? 'var(--accent-amber)' : 'var(--accent-green)',
                marginTop: '5px',
              }}
            />
            <p style={{ fontSize: '13px', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>
              {i.body}
            </p>
          </div>
        ))}
    </div>
  )
}

function Banner({ tone, children }: { tone: 'red' | 'green' | 'amber'; children: React.ReactNode }) {
  const colour =
    tone === 'red' ? 'var(--accent-red)' : tone === 'amber' ? 'var(--accent-amber)' : 'var(--accent-green)'
  return (
    <div className="wl-card" style={{ padding: '14px 18px' }}>
      <div className="flex items-start gap-2.5">
        <span className="wl-dot shrink-0" style={{ background: colour, marginTop: '5px' }} />
        <p style={{ fontSize: '13px', color: 'var(--ink-secondary)', lineHeight: 1.5 }}>{children}</p>
      </div>
    </div>
  )
}

/** Name something new: type, Enter to create, Escape to back out. */
function NameField({
  value,
  placeholder,
  onChange,
  onCreate,
  onCancel,
  busy,
  centred,
}: {
  value: string
  placeholder: string
  onChange: (v: string) => void
  onCreate: () => void
  onCancel: () => void
  busy: boolean
  centred?: boolean
}) {
  return (
    <div className={`flex items-center gap-2 flex-wrap${centred ? ' justify-center' : ''}`}>
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(ev) => onChange(ev.target.value)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' && value.trim() && !busy) onCreate()
          if (ev.key === 'Escape') onCancel()
        }}
        style={{ ...miniInput, fontSize: '14px', padding: '8px 11px', flex: '0 1 300px', minWidth: '190px' }}
      />
      <button onClick={onCreate} disabled={busy || !value.trim()} className="wl-btn-primary">
        {busy ? 'Creating…' : 'Create'}
      </button>
      <button onClick={onCancel} disabled={busy} className="wl-btn-secondary">
        Cancel
      </button>
    </div>
  )
}

type ComposeState = {
  labelId: string
  name: string
  value: string
  touched: boolean
  fallback: boolean
} | null

function LabelCard({
  view,
  edited,
  dirty,
  busy,
  takenSlots,
  bucketDraft,
  newBucket,
  onPatch,
  onSave,
  onDelete,
  onRecompute,
  onPatchBucket,
  onSaveBucket,
  onDeleteBucket,
  bucketIsDirty,
  onCompose,
  onComposeChange,
  onComposeCancel,
  onComposeCreate,
}: {
  view: LabelView
  edited: CustomLabel
  dirty: boolean
  busy: string | null
  takenSlots: Set<number>
  bucketDraft: Record<string, Bucket>
  newBucket: ComposeState
  onPatch: (change: Partial<CustomLabel>) => void
  onSave: () => void
  onDelete: () => void
  onRecompute: () => void
  onPatchBucket: (b: Bucket, change: Partial<Bucket>) => void
  onSaveBucket: (b: Bucket) => void
  onDeleteBucket: (b: Bucket) => void
  bucketIsDirty: (b: Bucket) => boolean
  onCompose: (fallback: boolean) => void
  onComposeChange: (s: ComposeState) => void
  onComposeCancel: () => void
  onComposeCreate: () => void
}) {
  const { label, buckets, counts, assigned, stale } = view
  const composing = newBucket?.labelId === label.id ? newBucket : null
  const hasFallback = buckets.some((b) => b.is_fallback)

  return (
    <div className="wl-card" style={{ padding: '18px 20px' }}>
      {/* ── Identity ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <select
            value={edited.slot ?? ''}
            onChange={(ev) => onPatch({ slot: ev.target.value === '' ? null : Number(ev.target.value) })}
            style={{ ...miniInput, fontVariantNumeric: 'tabular-nums' }}
            title="Which of Google's five slots this dimension occupies"
          >
            <option value="">no slot</option>
            {SLOTS.map((n) => (
              <option key={n} value={n} disabled={takenSlots.has(n) && edited.slot !== n}>
                custom_label_{n}
              </option>
            ))}
          </select>
          <input
            value={edited.name}
            onChange={(ev) => onPatch({ name: ev.target.value })}
            placeholder="Name this label"
            aria-label="Custom label name"
            title="Rename — Enter to save"
            className="wl-inline-edit"
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && dirty && edited.name.trim()) onSave()
            }}
            style={{ fontSize: '17px', fontWeight: 500, minWidth: '14ch' }}
          />
        </div>

        <div className="flex items-center gap-2">
          <span style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            {assigned.toLocaleString('da-DK')} labelled
          </span>
          {dirty && (
            <button onClick={onSave} disabled={busy === label.id} className="wl-btn-primary">
              {busy === label.id ? 'Saving…' : 'Save'}
            </button>
          )}
          <button
            onClick={onRecompute}
            disabled={busy === `recompute:${label.id}`}
            className="wl-btn-secondary"
          >
            {busy === `recompute:${label.id}` ? 'Computing…' : 'Recompute'}
          </button>
          <button
            onClick={onDelete}
            disabled={busy === label.id}
            className="wl-btn-secondary"
            style={{ color: 'var(--accent-red)' }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* ── What it measures ── */}
      <div className="flex flex-wrap items-end gap-6" style={{ marginTop: '16px' }}>
        <div className="space-y-1.5">
          <div className="wl-eyebrow">Level</div>
          <div className="flex gap-1">
            {(['product', 'variant'] as BucketLevel[]).map((l) => (
              <button
                key={l}
                onClick={() => l !== edited.level && onPatch({ level: l })}
                className="wl-pill"
                style={pillStyle(l === edited.level)}
              >
                {l === 'product' ? 'Per product' : 'Per variant'}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="wl-eyebrow">Window</div>
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => w !== edited.window_days && onPatch({ window_days: w })}
                className="wl-pill"
                style={pillStyle(w === edited.window_days)}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {(stale.never || stale.dataNewer || stale.settingsNewer) && (
        <p
          style={{
            fontSize: '12px',
            color: 'var(--accent-amber)',
            marginTop: '12px',
            lineHeight: 1.5,
            maxWidth: '68ch',
          }}
        >
          {stale.never
            ? 'Never computed — no product carries a value for this label yet.'
            : stale.settingsNewer
              ? 'The Google Ads settings changed after this was computed. If the revenue or gross profit actions were among them, these values describe the old definition.'
              : 'Google Ads data has been synced since this was computed, so these values describe an older window.'}
        </p>
      )}

      {/* ── Values ── */}
      <div className="space-y-2" style={{ marginTop: '18px' }}>
        {buckets.map((b) =>
          isGhost(b.id) ? (
            <GhostBlock key={b.id} bucket={b} />
          ) : (
            <BucketBlock
              key={b.id}
              bucket={bucketDraft[b.id] ?? b}
              dirty={bucketIsDirty(b)}
              busy={busy === b.id}
              count={counts[b.id] ?? 0}
              share={assigned ? Math.round(((counts[b.id] ?? 0) / assigned) * 100) : 0}
              onPatch={(change) => onPatchBucket(b, change)}
              onSave={() => onSaveBucket(b)}
              onDelete={() => onDeleteBucket(b)}
            />
          )
        )}
      </div>

      {composing ? (
        <div
          className="space-y-2"
          style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--hairline)' }}
        >
          <div className="wl-eyebrow">{composing.fallback ? 'New catch-all' : 'New value'}</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              autoFocus
              value={composing.name}
              placeholder="Name, e.g. High performers"
              onChange={(ev) =>
                onComposeChange({
                  ...composing,
                  name: ev.target.value,
                  value: composing.touched ? composing.value : slugify(ev.target.value),
                })
              }
              onKeyDown={(ev) => {
                if (ev.key === 'Escape') onComposeCancel()
              }}
              style={{ ...miniInput, fontSize: '14px', padding: '8px 11px', flex: '0 1 240px' }}
            />
            <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>emits</span>
            <input
              value={composing.value}
              placeholder="high"
              onChange={(ev) => onComposeChange({ ...composing, value: ev.target.value, touched: true })}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' && composing.name.trim() && composing.value.trim()) onComposeCreate()
                if (ev.key === 'Escape') onComposeCancel()
              }}
              style={{ ...miniInput, fontSize: '14px', padding: '8px 11px', flex: '0 1 160px', fontFamily: 'var(--font-mono)' }}
            />
            <button
              onClick={onComposeCreate}
              disabled={busy === 'add-bucket' || !composing.name.trim() || !composing.value.trim()}
              className="wl-btn-primary"
            >
              {busy === 'add-bucket' ? 'Creating…' : 'Create'}
            </button>
            <button onClick={onComposeCancel} className="wl-btn-secondary">
              Cancel
            </button>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--ink-muted)', lineHeight: 1.5, maxWidth: '64ch' }}>
            The name is for this screen; the value is the text Google would receive — keep it
            short and stable, it ends up as a column heading in Merchant Center reports.
            {composing.fallback
              ? ' A catch-all takes everything no earlier value matched, so it applies as soon as it exists.'
              : ' You add the conditions next; nothing is labelled until you save them.'}
          </p>
        </div>
      ) : (
        <div className="flex gap-2" style={{ marginTop: '14px' }}>
          <button onClick={() => onCompose(false)} className="wl-btn-secondary">
            + Add value
          </button>
          {!hasFallback && (
            <button
              onClick={() => onCompose(true)}
              className="wl-btn-secondary"
              title="Matches everything no earlier value did"
            >
              + Add catch-all
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const pillStyle = (active: boolean): React.CSSProperties => ({
  cursor: 'pointer',
  background: active ? 'var(--accent-purple)' : 'transparent',
  color: active ? '#fff' : 'var(--ink-muted)',
  border: active ? 'none' : '1px solid var(--hairline)',
})

function BucketBlock({
  bucket,
  dirty,
  busy,
  count,
  share,
  onPatch,
  onSave,
  onDelete,
}: {
  bucket: Bucket
  dirty: boolean
  busy: boolean
  count: number
  share: number
  onPatch: (change: Partial<Bucket>) => void
  onSave: () => void
  onDelete: () => void
}) {
  return (
    <div
      style={{
        border: '1px solid var(--hairline)',
        borderRadius: '10px',
        padding: '12px 14px',
        background: 'var(--bg-base)',
      }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {bucket.is_fallback ? (
            <span className="wl-pill" style={{ background: 'var(--bg-surface)', color: 'var(--ink-muted)' }}>
              last
            </span>
          ) : (
            <input
              type="number"
              value={bucket.priority}
              onChange={(ev) => onPatch({ priority: Number(ev.target.value) })}
              title="Evaluation order — lower runs first, first match wins"
              aria-label="Priority"
              style={{ ...miniInput, width: '58px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
            />
          )}
          <input
            value={bucket.name}
            onChange={(ev) => onPatch({ name: ev.target.value })}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && dirty && bucket.name.trim()) onSave()
            }}
            placeholder="Name this value"
            aria-label="Bucket name"
            title="Rename — Enter to save"
            className="wl-inline-edit"
            style={{ fontSize: '14px', fontWeight: 500, minWidth: '12ch' }}
          />
          <span style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>emits</span>
          <input
            value={bucket.value}
            onChange={(ev) => onPatch({ value: ev.target.value })}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' && dirty && bucket.value.trim()) onSave()
            }}
            aria-label="Emitted value"
            title="What Google would receive"
            className="wl-inline-edit"
            style={{ fontSize: '13px', minWidth: '8ch', fontFamily: 'var(--font-mono)' }}
          />
        </div>

        <div className="flex items-center gap-3">
          <span style={{ fontSize: '13px', color: 'var(--ink)' }}>
            {count} <span style={{ color: 'var(--ink-muted)' }}>({share}%)</span>
          </span>
          <div
            style={{
              width: '80px',
              height: '6px',
              borderRadius: '3px',
              background: 'var(--bg-surface)',
              overflow: 'hidden',
            }}
          >
            <div style={{ width: `${share}%`, height: '100%', background: 'var(--accent-purple)' }} />
          </div>
        </div>
      </div>

      {bucket.is_fallback ? (
        <p style={{ fontSize: '12px', color: 'var(--ink-muted)', marginTop: '10px' }}>
          Catch-all — everything no earlier value matched.
        </p>
      ) : (
        <div className="space-y-2" style={{ marginTop: '10px' }}>
          {/* An empty bucket shows 0 products, which without this reads as a
              result rather than as "not asked yet". */}
          {(bucket.rules ?? []).length === 0 && (
            <p style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
              No conditions yet - nothing is labelled until you add one and save.
            </p>
          )}
          {(bucket.rules ?? []).map((rule, i) => (
            <RuleRow
              key={i}
              rule={rule}
              matchType={bucket.match_type}
              showJoin={i > 0}
              onJoinChange={(m) => onPatch({ match_type: m })}
              onChange={(next) => onPatch({ rules: bucket.rules.map((r, j) => (j === i ? next : r)) })}
              onRemove={() => onPatch({ rules: bucket.rules.filter((_, j) => j !== i) })}
            />
          ))}
          <button
            onClick={() =>
              onPatch({ rules: [...(bucket.rules ?? []), { metric: 'clicks', operator: 'gte', value: 25 }] })
            }
            style={{
              fontSize: '12px',
              color: 'var(--accent-purple)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            + Add condition
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 justify-end" style={{ marginTop: '10px' }}>
        {dirty && (
          <button onClick={onSave} disabled={busy} className="wl-btn-primary">
            {busy ? 'Saving…' : 'Save'}
          </button>
        )}
        <button
          onClick={onDelete}
          disabled={busy}
          className="wl-btn-secondary"
          style={{ color: 'var(--accent-red)' }}
        >
          Delete
        </button>
      </div>
    </div>
  )
}

function RuleRow({
  rule,
  matchType,
  showJoin,
  onJoinChange,
  onChange,
  onRemove,
}: {
  rule: BucketRule
  matchType: 'ALL' | 'ANY'
  showJoin: boolean
  onJoinChange: (m: 'ALL' | 'ANY') => void
  onChange: (r: BucketRule) => void
  onRemove: () => void
}) {
  const op = OPERATORS.find((o) => o.value === rule.operator)
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div style={{ width: '72px', flexShrink: 0 }}>
        {showJoin ? (
          <select
            value={matchType}
            onChange={(e) => onJoinChange(e.target.value as 'ALL' | 'ANY')}
            title="Applies to every condition in this bucket"
            style={{ ...miniInput, width: '100%' }}
          >
            <option value="ALL">and</option>
            <option value="ANY">or</option>
          </select>
        ) : (
          <span
            style={{
              fontSize: '13px',
              color: 'var(--ink-secondary)',
              paddingLeft: '9px',
              display: 'inline-block',
            }}
          >
            if
          </span>
        )}
      </div>

      <select
        value={rule.metric}
        onChange={(e) => onChange({ ...rule, metric: e.target.value as BucketMetric })}
        style={{ ...miniInput, minWidth: '130px' }}
      >
        {BUCKET_METRICS.map((m) => (
          <option key={m} value={m}>
            {METRIC_LABEL[m]}
          </option>
        ))}
      </select>

      <select
        value={rule.operator}
        onChange={(e) => onChange({ ...rule, operator: e.target.value as BucketOperator })}
        style={{ ...miniInput, minWidth: '110px' }}
      >
        {OPERATORS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {op?.needsValue && (
        <input
          type="number"
          step="any"
          value={rule.value ?? ''}
          onChange={(e) =>
            onChange({ ...rule, value: e.target.value === '' ? undefined : Number(e.target.value) })
          }
          style={{ ...miniInput, width: '90px' }}
        />
      )}

      <button
        onClick={onRemove}
        title="Remove condition"
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--ink-muted)',
          cursor: 'pointer',
          fontSize: '14px',
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  )
}

function PreviewSection({ table, labels }: { table: PreviewTable; labels: LabelView[] }) {
  const columns = table.labelIds
    .map((id) => labels.find((v) => v.label.id === id))
    .filter((v): v is LabelView => !!v)

  return (
    <section className="wl-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
        <span className="wl-eyebrow">
          {table.level === 'product' ? 'Per product' : 'Per variant'} · what each one carries
        </span>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: '520px', overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--hairline)' }}>
              <Th first>{table.level === 'product' ? 'Product ID' : 'Item ID'}</Th>
              <Th>Title</Th>
              {columns.map((c) => (
                <Th key={c.label.id}>
                  {c.label.slot !== null ? `custom_label_${c.label.slot}` : c.label.name}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r.ref} style={{ borderBottom: '0.5px solid var(--hairline)' }}>
                <td
                  style={{
                    padding: '8px 12px 8px 18px',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--ink-secondary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {r.ref}
                </td>
                <td style={{ padding: '8px 12px', color: 'var(--ink)', maxWidth: '280px' }}>
                  <span className="truncate block">{r.title ?? '—'}</span>
                </td>
                {columns.map((c) => {
                  const cell = r.cells[c.label.id]
                  return (
                    <td key={c.label.id} style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      {cell ? (
                        <span className="wl-pill" style={{ background: 'var(--bg-surface)', color: 'var(--ink)' }}>
                          {cell.value}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--ink-muted)' }}>—</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.total > table.rows.length && (
        <p style={{ fontSize: '11px', color: 'var(--ink-muted)', padding: '10px 18px' }}>
          Showing {table.rows.length} of {table.total}.
        </p>
      )}
    </section>
  )
}

function Th({ children, first }: { children: React.ReactNode; first?: boolean }) {
  return (
    <th
      style={{
        padding: first ? '10px 12px 10px 18px' : '10px 12px',
        textAlign: 'left',
        fontSize: '11px',
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--ink-muted)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  )
}
