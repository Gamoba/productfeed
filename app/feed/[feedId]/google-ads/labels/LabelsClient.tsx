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
import { formatNumber } from '@/lib/formatDa'
import './labels.css'

// Feed › Labels (reference: references/feed_labels.jpg). Pick a custom label
// slot at the top; its buckets are listed on the left in the order they are
// checked (first match wins), and the selected bucket is edited on the right
// with the products it holds underneath.
//
// Level (per product / per variant) is not chosen here: it follows the feed's
// own structure from Settings (GUIDELINES §4). Nothing here writes to Shopify.

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
  connected: boolean
  // The feed's structure (feed_settings.feed_mode). Labels measure at this level.
  feedMode: BucketLevel
  currency: string | null
  roasActions: string[]
  poasActions: string[]
  labels: LabelView[]
  tables: PreviewTable[]
}

const METRIC_LABEL: Record<BucketMetric, string> = {
  roas: 'ROAS',
  poas: 'POAS',
  conversions: 'Konverteringer (kontoens standard)',
  roas_conversions: 'Konverteringer (omsætning)',
  poas_conversions: 'Konverteringer (bruttoprofit)',
  conversions_value: 'Omsætning',
  cost: 'Forbrug',
  clicks: 'Klik',
  impressions: 'Visninger',
  profit_after_ad_spend: 'Profit minus forbrug',
  cogs_margin: 'Margin (kostpris)',
  inventory_quantity: 'Lager (stk.)',
  stock_coverage: 'Lagerdækning',
  days_of_stock: 'Dages lager',
}

const OPERATORS: { value: BucketOperator; label: string; needsValue: boolean }[] = [
  { value: 'gt', label: '>', needsValue: true },
  { value: 'gte', label: '≥', needsValue: true },
  { value: 'lt', label: '<', needsValue: true },
  { value: 'lte', label: '≤', needsValue: true },
  { value: 'eq', label: '=', needsValue: true },
  { value: 'neq', label: '≠', needsValue: true },
  { value: 'is_empty', label: 'har ingen værdi', needsValue: false },
  { value: 'is_not_empty', label: 'har en værdi', needsValue: false },
]

const WINDOWS = [7, 14, 30, 90, 180, 365]
const SLOTS = [0, 1, 2, 3, 4]
const DOT = ['var(--hi)', '#101312', 'var(--series-2)', 'var(--bad)', 'var(--series-3)', 'var(--series-4)']
const LEVEL_LABEL: Record<BucketLevel, string> = { product: 'Pr. vare (varianter samlet)', variant: 'Pr. variant' }

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

const rulesKey = (rules: BucketRule[] = []) =>
  rules.map((r) => `${r.metric}|${r.operator}|${r.value ?? ''}|${r.windowDays ?? ''}`).join(';')

const GHOST_PREFIX = 'ghost:'
const isGhost = (id: string) => id.startsWith(GHOST_PREFIX)

type Compose = { labelId: string; name: string; value: string; touched: boolean; fallback: boolean } | null

export function LabelsClient(props: Props) {
  const { feedId, connected, feedMode, roasActions, poasActions, labels, tables } = props
  const router = useRouter()

  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])

  const [labelDraft, setLabelDraft] = useState<Record<string, CustomLabel>>({})
  const [bucketDraft, setBucketDraft] = useState<Record<string, Bucket>>({})
  const [pendingDelete, setPendingDelete] = useState<Set<string>>(new Set())
  const [ghosts, setGhosts] = useState<Bucket[]>([])

  const [selLabelId, setSelLabelId] = useState<string | null>(null)
  const [selBucketId, setSelBucketId] = useState<string | null>(null)
  // A new label being named, for a given slot (null = no slot).
  const [newLabel, setNewLabel] = useState<{ slot: number | null; name: string } | null>(null)
  const [compose, setCompose] = useState<Compose>(null)

  const liveIds = new Set(labels.flatMap((v) => v.buckets.map((b) => b.id)))
  const arrived = new Set(labels.flatMap((v) => v.buckets.map((b) => `${b.label_id}:${b.name}`)))
  const hiding = new Set([...pendingDelete].filter((id) => liveIds.has(id)))
  const pendingNew = ghosts.filter((g) => !arrived.has(`${g.label_id}:${g.name}`))

  const editedLabel = (l: CustomLabel) => labelDraft[l.id] ?? l
  const editedBucket = (b: Bucket) => bucketDraft[b.id] ?? b

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
      setError((json as { error?: string }).error ?? 'Noget gik galt')
      return null
    }
    return json as Record<string, unknown>
  }
  const post = (url: string, body: unknown) =>
    call(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  // ── Recompute ──────────────────────────────────────────────────────────────

  async function recompute(labelId?: string) {
    setBusy(labelId ? `recompute:${labelId}` : 'recompute')
    setError(null)
    const json = await post(`/api/google-ads/${feedId}/labels/recompute`, labelId ? { labelId } : {})
    setBusy(null)
    if (json) {
      const r = json.result as {
        labels: { name: string; assigned: number; entities: number; moved: number; warnings: string[] }[]
        warnings: string[]
      }
      const per = r.labels ?? []
      setNote(
        per.length === 1
          ? `${per[0].name}: ${formatNumber(per[0].assigned)} af ${formatNumber(per[0].entities)} har fået et label · ${formatNumber(per[0].moved)} skiftede værdi.`
          : `${per.length} labels genberegnet · ${formatNumber(per.reduce((n, l) => n + l.moved, 0))} skiftede værdi.`
      )
      setWarnings([...(r.warnings ?? []), ...per.flatMap((l) => l.warnings.map((w) => `${l.name}: ${w}`))])
    }
    router.refresh()
  }

  // ── Labels ─────────────────────────────────────────────────────────────────

  async function saveLabel(view: LabelView) {
    const before = view.label
    // The level always follows the feed's structure.
    const after = { ...editedLabel(before), level: feedMode }
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
      setNote('Gemt. Intet ved det, der måles, er ændret, så der er ikke genberegnet.')
      router.refresh()
    }
  }

  async function addLabel() {
    if (!newLabel) return
    const name = newLabel.name.trim()
    if (!name) return
    setBusy('add-label')
    setError(null)
    const ok = await post(`/api/google-ads/${feedId}/labels`, {
      action: 'save',
      label: { name, slot: newLabel.slot, level: feedMode, window_days: 30 },
    })
    setBusy(null)
    if (ok) {
      setNewLabel(null)
      router.refresh()
    }
  }

  async function removeLabel(view: LabelView) {
    if (!confirm(`Slet labelet “${view.label.name}” og dets buckets? Varerne mister værdien for dette label.`)) return
    setBusy(view.label.id)
    setError(null)
    const ok = await call(`/api/google-ads/${feedId}/labels?id=${view.label.id}`, { method: 'DELETE' })
    setBusy(null)
    if (ok) {
      setSelLabelId(null)
      router.refresh()
    }
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
    if (moves) await recompute(b.label_id)
    else {
      setNote('Gemt. Ingen betingelse er ændret, så der er ikke genberegnet.')
      router.refresh()
    }
  }

  async function addBucket() {
    if (!compose) return
    const { labelId, name, value, fallback } = compose
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
    setCompose(null)
    const ok = await post(`/api/google-ads/${feedId}/buckets`, { bucket })
    if (!ok) {
      setGhosts((g) => g.filter((x) => x.id !== ghostId))
      setCompose({ labelId, name, value, touched: true, fallback })
      return
    }
    if (fallback) await recompute(labelId)
    else router.refresh()
  }

  async function removeBucket(b: Bucket) {
    if (!confirm(`Slet bucketen “${b.name}”? Varerne i den går videre til de næste buckets.`)) return
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
    setSelBucketId(null)
    await recompute(b.label_id)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <div className="lb">
        <Head />
        <section className="card lb-empty">
          <h3>Feedet er ikke koblet til Google Ads</h3>
          <p>Labels deler varerne efter, hvordan de klarer sig, så feedet skal have en Google Ads-konto og mindst én synkronisering først.</p>
          <Link href={`/feed/${feedId}/google-ads`} className="wl-btn-primary">
            Gå til Performance
          </Link>
        </section>
      </div>
    )
  }

  const views = labels.map((v): LabelView => {
    const kept = v.buckets.filter((b) => !hiding.has(b.id))
    const mine = pendingNew.filter((g) => g.label_id === v.label.id)
    if (kept.length === v.buckets.length && !mine.length) return v
    return { ...v, buckets: orderBuckets([...kept, ...mine]) }
  })
  const bySlot = new Map(views.filter((v) => v.label.slot !== null).map((v) => [v.label.slot as number, v]))
  const unslotted = views.filter((v) => v.label.slot === null)
  const current =
    views.find((v) => v.label.id === selLabelId) ??
    SLOTS.map((s) => bySlot.get(s)).find(Boolean) ??
    unslotted[0] ??
    null
  const takenSlots = new Set(views.map((v) => editedLabel(v.label).slot).filter((s): s is number => s !== null))

  const shared = roasActions.filter((a) => poasActions.includes(a))
  const sameAction = shared.length > 0 && shared.length === roasActions.length && shared.length === poasActions.length

  return (
    <div className="lb">
      <Head
        actions={
          labels.length > 0 && (
            <button onClick={() => recompute()} disabled={busy === 'recompute'} className="wl-btn-primary">
              {busy === 'recompute' ? 'Genberegner…' : 'Genberegn alle'}
            </button>
          )
        }
      />

      {/* Slot selector */}
      <div className="lb-top">
        <span className="lb-top-l">Custom label</span>
        <div className="lb-seg" role="tablist" aria-label="Custom label">
          {SLOTS.map((s) => {
            const v = bySlot.get(s)
            const on = !!v && current?.label.id === v.label.id
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={on || (newLabel?.slot === s && !v)}
                className={v ? undefined : 'lb-free'}
                onClick={() => {
                  setNewLabel(null)
                  if (v) {
                    setSelLabelId(v.label.id)
                    setSelBucketId(null)
                  } else setNewLabel({ slot: s, name: '' })
                }}
                title={v ? `custom_label_${s}` : `custom_label_${s} er ledig. Klik for at lave et label her.`}
              >
                {s}
                {v ? ` · ${v.label.name}` : ''}
              </button>
            )
          })}
          {unslotted.map((v) => (
            <button
              key={v.label.id}
              type="button"
              role="tab"
              aria-selected={current?.label.id === v.label.id}
              onClick={() => {
                setNewLabel(null)
                setSelLabelId(v.label.id)
                setSelBucketId(null)
              }}
              title="Uden slot: beregnes, men har ingen plads i feedet"
            >
              – · {v.label.name}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="note warn">{error}</p>}
      {note && !error && <p className="note lb-ok">{note}</p>}
      {warnings.map((w, i) => (
        <p key={i} className="note warn">
          {w}
        </p>
      ))}
      {sameAction && (
        <p className="note warn">
          Omsætning og bruttoprofit bruger samme konverteringshandling ({roasActions.join(', ')}), så POAS er lig ROAS.
          Ret det på Performance-siden.
        </p>
      )}

      {newLabel ? (
        <section className="card lb-new">
          <h3>Nyt label{newLabel.slot !== null ? ` i custom_label_${newLabel.slot}` : ''}</h3>
          <div className="lb-row">
            <input
              autoFocus
              className="ff-input"
              value={newLabel.name}
              placeholder="fx Performance"
              onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addLabel()
                if (e.key === 'Escape') setNewLabel(null)
              }}
            />
            <button className="wl-btn-primary" onClick={() => void addLabel()} disabled={busy === 'add-label' || !newLabel.name.trim()}>
              {busy === 'add-label' ? 'Opretter…' : 'Opret label'}
            </button>
            <button className="wl-btn-secondary" onClick={() => setNewLabel(null)}>
              Annullér
            </button>
          </div>
          <p className="lb-muted">Navnet er til denne side. Værdierne, Google får, sætter du på hver bucket.</p>
        </section>
      ) : !current ? (
        <section className="card lb-empty">
          <h3>Ingen labels endnu</h3>
          <p>Vælg en ledig plads ovenfor (0 til 4) for at lave dit første label, fx Performance.</p>
        </section>
      ) : (
        <LabelEditor
          key={current.label.id}
          feedId={feedId}
          view={current}
          edited={editedLabel(current.label)}
          dirty={!!labelDraft[current.label.id]}
          feedMode={feedMode}
          busy={busy}
          takenSlots={takenSlots}
          selBucketId={selBucketId}
          onSelectBucket={setSelBucketId}
          bucketDraft={bucketDraft}
          compose={compose?.labelId === current.label.id ? compose : null}
          table={tables.find((t) => t.labelIds.includes(current.label.id)) ?? null}
          onPatch={(c) => patchLabel(current.label, c)}
          onSave={() => void saveLabel(current)}
          onDelete={() => void removeLabel(current)}
          onRecompute={() => void recompute(current.label.id)}
          onPatchBucket={patchBucket}
          onSaveBucket={(b) => void saveBucket(b)}
          onDeleteBucket={(b) => void removeBucket(b)}
          onCompose={(fallback) =>
            setCompose({
              labelId: current.label.id,
              name: fallback ? 'Alt andet' : '',
              value: fallback ? 'other' : '',
              touched: fallback,
              fallback,
            })
          }
          onComposeChange={setCompose}
          onComposeCreate={() => void addBucket()}
        />
      )}

      <p className="lb-muted lb-foot">
        Labels beregnes og vises her. Intet skrives til feedet eller sendes til Merchant Center endnu.
      </p>
    </div>
  )
}

function Head({ actions }: { actions?: React.ReactNode }) {
  return (
    <div className="lb-head">
      <div>
        <h1>Labels</h1>
        <p className="lb-lede">
          Giv varerne et label ud fra, hvordan de klarer sig. Brug det til at dele kampagner og budget i Google Ads.
        </p>
      </div>
      {actions && <div className="lb-actions">{actions}</div>}
    </div>
  )
}

// ── One label: buckets on the left, the selected bucket on the right ────────

function LabelEditor({
  feedId,
  view,
  edited,
  dirty,
  feedMode,
  busy,
  takenSlots,
  selBucketId,
  onSelectBucket,
  bucketDraft,
  compose,
  table,
  onPatch,
  onSave,
  onDelete,
  onRecompute,
  onPatchBucket,
  onSaveBucket,
  onDeleteBucket,
  onCompose,
  onComposeChange,
  onComposeCreate,
}: {
  feedId: string
  view: LabelView
  edited: CustomLabel
  dirty: boolean
  feedMode: BucketLevel
  busy: string | null
  takenSlots: Set<number>
  selBucketId: string | null
  onSelectBucket: (id: string | null) => void
  bucketDraft: Record<string, Bucket>
  compose: Compose
  table: PreviewTable | null
  onPatch: (c: Partial<CustomLabel>) => void
  onSave: () => void
  onDelete: () => void
  onRecompute: () => void
  onPatchBucket: (b: Bucket, c: Partial<Bucket>) => void
  onSaveBucket: (b: Bucket) => void
  onDeleteBucket: (b: Bucket) => void
  onCompose: (fallback: boolean) => void
  onComposeChange: (c: Compose) => void
  onComposeCreate: () => void
}) {
  const { label, buckets, counts, assigned, stale } = view
  const real = buckets.filter((b) => !isGhost(b.id))
  const selected = real.find((b) => b.id === selBucketId) ?? real[0] ?? null
  const hasFallback = buckets.some((b) => b.is_fallback)
  const levelDiffers = label.level !== feedMode
  const recomputing = busy === `recompute:${label.id}`

  return (
    <>
      <section className="card lb-settings">
        <div className="lb-row lb-wrap">
          <input
            value={edited.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && dirty && edited.name.trim() && onSave()}
            aria-label="Labelets navn"
            className="wl-inline-edit lb-name"
          />
          <select
            className="ff-select lb-slot"
            value={edited.slot ?? ''}
            onChange={(e) => onPatch({ slot: e.target.value === '' ? null : Number(e.target.value) })}
            aria-label="Plads i feedet"
          >
            <option value="">Uden slot</option>
            {SLOTS.map((n) => (
              <option key={n} value={n} disabled={takenSlots.has(n) && edited.slot !== n}>
                custom_label_{n}
              </option>
            ))}
          </select>
          <span className="lb-spacer" />
          <span className="lb-muted">{formatNumber(assigned)} varer har et label</span>
          {dirty && (
            <button onClick={onSave} disabled={busy === label.id} className="wl-btn-primary">
              {busy === label.id ? 'Gemmer…' : 'Gem'}
            </button>
          )}
          <button onClick={onRecompute} disabled={recomputing} className="wl-btn-secondary">
            {recomputing ? 'Genberegner…' : 'Genberegn'}
          </button>
          <button onClick={onDelete} disabled={busy === label.id} className="wl-btn-secondary lb-danger">
            Slet label
          </button>
        </div>

        <div className="lb-row lb-wrap lb-measure">
          <div>
            <span className="lb-k">Lookback-vindue</span>
            <div className="lb-pills" role="group" aria-label="Lookback-vindue">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={w === edited.window_days}
                  onClick={() => w !== edited.window_days && onPatch({ window_days: w })}
                >
                  {w}d
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="lb-k">Niveau</span>
            <p className="lb-level">
              {LEVEL_LABEL[feedMode]} ·{' '}
              <Link href={`/feed/${feedId}/settings`} className="link">
                følger feedets opbygning
              </Link>
            </p>
          </div>
        </div>
        <p className="lb-muted lb-small">
          Et kort vindue reagerer hurtigt i en sæson. Et langt vindue giver flere varer nok klik til at blive dømt.
        </p>
        {levelDiffers && (
          <p className="note warn">
            Labelet er beregnet {LEVEL_LABEL[label.level].toLowerCase()}, men feedet er {LEVEL_LABEL[feedMode].toLowerCase()}. Gem
            labelet for at følge feedet.
          </p>
        )}
        {(stale.never || stale.dataNewer || stale.settingsNewer) && (
          <p className="note warn">
            {stale.never
              ? 'Aldrig beregnet. Ingen varer har en værdi for dette label endnu.'
              : stale.settingsNewer
                ? 'Google Ads-indstillingerne er ændret siden beregningen. Genberegn, hvis omsætning eller bruttoprofit var blandt ændringerne.'
                : 'Der er hentet nye Google Ads-tal siden beregningen. Genberegn for at bruge dem.'}
          </p>
        )}
      </section>

      <div className="lb-split">
        <section className="card lb-buckets">
          <div className="lb-card-h">
            <h3>Buckets</h3>
            <small>Tjekkes oppefra. Første match vinder.</small>
          </div>
          <ul>
            {buckets.map((b, i) => {
              const e = bucketDraft[b.id] ?? b
              const ghost = isGhost(b.id)
              const on = !ghost && selected?.id === b.id
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`lb-bucket${on ? ' on' : ''}${ghost ? ' ghost' : ''}`}
                    aria-pressed={on}
                    disabled={ghost}
                    onClick={() => onSelectBucket(b.id)}
                  >
                    <span className="lb-prio">{b.is_fallback ? '·' : i + 1}</span>
                    <span className="lb-bt">
                      <b>{e.name}</b>
                      <small>{ghost ? 'Opretter…' : e.value}</small>
                    </span>
                    <span className="lb-bc num">
                      <b>{formatNumber(counts[b.id] ?? 0)}</b>
                      <small>varer</small>
                    </span>
                    <span className="lb-dot" style={{ background: DOT[i % DOT.length] }} />
                  </button>
                </li>
              )
            })}
          </ul>

          {compose ? (
            <div className="lb-compose">
              <input
                autoFocus
                className="ff-input"
                value={compose.name}
                placeholder={compose.fallback ? 'Navn' : 'Navn, fx Highly profitable'}
                onChange={(e) =>
                  onComposeChange({ ...compose, name: e.target.value, value: compose.touched ? compose.value : slugify(e.target.value) })
                }
                onKeyDown={(e) => e.key === 'Escape' && onComposeChange(null)}
              />
              <input
                className="ff-input"
                value={compose.value}
                placeholder="Værdi i feedet, fx highly_profitable"
                onChange={(e) => onComposeChange({ ...compose, value: e.target.value, touched: true })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && compose.name.trim() && compose.value.trim()) onComposeCreate()
                  if (e.key === 'Escape') onComposeChange(null)
                }}
              />
              <div className="lb-row">
                <button className="wl-btn-primary" onClick={onComposeCreate} disabled={!compose.name.trim() || !compose.value.trim()}>
                  Opret
                </button>
                <button className="wl-btn-secondary" onClick={() => onComposeChange(null)}>
                  Annullér
                </button>
              </div>
              <p className="lb-muted lb-small">
                {compose.fallback
                  ? 'Fallback tager alt, ingen tidligere bucket matchede, og gælder, så snart den findes.'
                  : 'Værdien er teksten, Google får. Hold den kort og stabil. Betingelserne sætter du bagefter.'}
              </p>
            </div>
          ) : (
            <div className="lb-addrow">
              <button type="button" className="lb-add" onClick={() => onCompose(false)}>
                + Ny bucket
              </button>
              {!hasFallback && (
                <button type="button" className="lb-add" onClick={() => onCompose(true)} title="Tager alt, ingen tidligere bucket matchede">
                  + Fallback
                </button>
              )}
            </div>
          )}
        </section>

        <div className="lb-right">
          {selected ? (
            <BucketEditor
              bucket={bucketDraft[selected.id] ?? selected}
              dirty={!!bucketDraft[selected.id]}
              busy={busy === selected.id}
              count={counts[selected.id] ?? 0}
              share={assigned ? Math.round(((counts[selected.id] ?? 0) / assigned) * 100) : 0}
              windowDays={edited.window_days}
              onPatch={(c) => onPatchBucket(selected, c)}
              onSave={() => onSaveBucket(selected)}
              onDelete={() => onDeleteBucket(selected)}
            />
          ) : (
            <section className="card lb-empty">
              <p>Labelet har ingen buckets endnu. Lav den første til venstre.</p>
            </section>
          )}
          {selected && table && <MembersCard table={table} labelId={label.id} bucket={selected} />}
        </div>
      </div>
    </>
  )
}

function BucketEditor({
  bucket,
  dirty,
  busy,
  count,
  share,
  windowDays,
  onPatch,
  onSave,
  onDelete,
}: {
  bucket: Bucket
  dirty: boolean
  busy: boolean
  count: number
  share: number
  windowDays: number
  onPatch: (c: Partial<Bucket>) => void
  onSave: () => void
  onDelete: () => void
}) {
  const rules = bucket.rules ?? []
  return (
    <section className="card">
      <div className="lb-row lb-wrap">
        <div className="lb-card-h lb-grow">
          <input
            value={bucket.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && dirty && bucket.name.trim() && onSave()}
            aria-label="Bucketens navn"
            className="wl-inline-edit lb-bname"
          />
          <small>
            {bucket.is_fallback ? 'Fallback: alt, ingen tidligere bucket matchede.' : 'Varer der matcher alle linjer, får værdien.'}
          </small>
        </div>
        <label className="lb-field">
          <span>Værdi i feedet</span>
          <input className="ff-input" value={bucket.value} onChange={(e) => onPatch({ value: e.target.value })} />
        </label>
        {!bucket.is_fallback && (
          <label className="lb-field lb-prio-f">
            <span>Rækkefølge</span>
            <input
              type="number"
              className="ff-input"
              value={bucket.priority}
              onChange={(e) => onPatch({ priority: Number(e.target.value) })}
              title="Lavere tjekkes først"
            />
          </label>
        )}
      </div>

      {!bucket.is_fallback && (
        <div className="lb-rules">
          {rules.length === 0 && <p className="lb-muted lb-small">Ingen betingelser endnu. Intet får dette label, før du tilføjer en og gemmer.</p>}
          {rules.map((rule, i) => {
            const op = OPERATORS.find((o) => o.value === rule.operator)
            return (
              <div className="lb-rule" key={i}>
                {i === 0 ? (
                  <span className="lb-kw">HVIS</span>
                ) : (
                  <select
                    className="ff-select lb-join"
                    value={bucket.match_type}
                    onChange={(e) => onPatch({ match_type: e.target.value as 'ALL' | 'ANY' })}
                    title="Gælder alle betingelser i bucketen"
                  >
                    <option value="ALL">OG</option>
                    <option value="ANY">ELLER</option>
                  </select>
                )}
                <select
                  className="ff-select"
                  value={rule.metric}
                  onChange={(e) => onPatch({ rules: rules.map((r, j) => (j === i ? { ...r, metric: e.target.value as BucketMetric } : r)) })}
                >
                  {BUCKET_METRICS.map((m) => (
                    <option key={m} value={m}>
                      {METRIC_LABEL[m]}
                    </option>
                  ))}
                </select>
                <select
                  className="ff-select lb-op"
                  value={rule.operator}
                  onChange={(e) => onPatch({ rules: rules.map((r, j) => (j === i ? { ...r, operator: e.target.value as BucketOperator } : r)) })}
                >
                  {OPERATORS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {op?.needsValue ? (
                  <input
                    type="number"
                    step="any"
                    className="ff-input lb-val"
                    value={rule.value ?? ''}
                    onChange={(e) =>
                      onPatch({
                        rules: rules.map((r, j) => (j === i ? { ...r, value: e.target.value === '' ? undefined : Number(e.target.value) } : r)),
                      })
                    }
                  />
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="lb-x"
                  aria-label="Fjern betingelse"
                  onClick={() => onPatch({ rules: rules.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            )
          })}
          <div className="lb-row lb-wrap">
            <button
              type="button"
              className="lb-add-inline"
              onClick={() => onPatch({ rules: [...rules, { metric: 'clicks', operator: 'gte', value: 25 }] })}
            >
              + Betingelse
            </button>
            <span className="lb-spacer" />
            <span className="lb-muted lb-small">Regnes på de sidste {windowDays} dage</span>
          </div>
        </div>
      )}

      <div className="lb-row lb-wrap lb-bfoot">
        <span className="num lb-share">
          <b>{formatNumber(count)}</b> varer · {share} %
        </span>
        <span className="lb-bar" aria-hidden="true">
          <i style={{ width: `${share}%` }} />
        </span>
        <span className="lb-spacer" />
        <button onClick={onDelete} disabled={busy} className="wl-btn-secondary lb-danger">
          Slet bucket
        </button>
        {dirty && (
          <button onClick={onSave} disabled={busy} className="wl-btn-primary">
            {busy ? 'Gemmer…' : 'Gem bucket'}
          </button>
        )}
      </div>
    </section>
  )
}

function MembersCard({ table, labelId, bucket }: { table: PreviewTable; labelId: string; bucket: Bucket }) {
  const rows = table.rows.filter((r) => r.cells[labelId]?.name === bucket.name)
  return (
    <section className="card flush">
      <div className="lb-card-h lb-pad">
        <h3>Varer i {bucket.name}</h3>
        <small>Alle får værdien {bucket.value}, som den var ved sidste beregning.</small>
      </div>
      {rows.length === 0 ? (
        <p className="lb-muted lb-small lb-pad">Ingen varer i denne bucket ved sidste beregning.</p>
      ) : (
        <div className="lb-tablewrap">
          <table className="lb-table">
            <thead>
              <tr>
                <th>{table.level === 'product' ? 'Vare-id' : 'Item-id'}</th>
                <th>Titel</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ref}>
                  <td className="num lb-muted">{r.ref}</td>
                  <td>{r.title ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table.total > table.rows.length && (
        <p className="lb-muted lb-small lb-pad">Ud af de første {formatNumber(table.rows.length)} af {formatNumber(table.total)} varer med labels.</p>
      )}
    </section>
  )
}
