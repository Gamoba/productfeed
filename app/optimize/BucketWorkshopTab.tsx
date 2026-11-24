'use client'

// Per-bucket example workshop (migrations 025 + 026 + lib/bucketExamples).
//
// The user writes instructions, picks prioritised input fields, then each round
// generates 5 deliberately DIFFERENT titling approaches (each with an AI rationale).
// Selecting a candidate approves it — a choice means "good", no notes needed. The
// approved set (≤5) is the few-shot. Generation replays the approved examples as
// "covered ground" so new rounds diverge instead of converging. Resumable per bucket.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getBucketTitleConfig,
  saveBucketTitleConfig,
  listBucketExamples,
  generateBucketCandidates,
  setBucketExampleStatus,
  deleteBucketExample,
  getFeedMetafields,
  getRoundProductContext,
} from './actions'
import { FILTER_FIELDS, type MetafieldOption } from '@/app/components/FilterEditor'
import { applyApprove, applyDelete, restoreDeleted, revertStatus } from './exampleOptimistic'
import type { BucketExample } from '@/lib/bucketExamples'
import type { ValidationResult } from '@/lib/titleOptimizer'

const MAX_APPROVED = 5

// Standard field tokens for the input-field picker (the metafield sentinel is
// dropped — metafields come from the feed scan instead).
const STANDARD_FIELDS = FILTER_FIELDS.filter((f) => f.value !== '__metafield__')

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

// Human label for a field token. Metafields prefer the definition NAME (e.g.
// "Årgang") over the raw, possibly-mangled key ("custom._rgang"), falling back to
// the key; standard fields use their friendly label.
function fieldLabel(token: string, metafields?: MetafieldOption[], bare = false): string {
  if (token.startsWith('metafield:')) {
    const nsKey = token.slice('metafield:'.length)
    const opt = metafields?.find((m) => `${m.namespace}.${m.key}` === nsKey)
    const name = opt?.name ?? nsKey
    return bare ? name : `${name} (metafelt)`
  }
  return STANDARD_FIELDS.find((f) => f.value === token)?.label ?? token
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5" aria-hidden>
      <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
    </svg>
  )
}

// Small numbered badge for the three step headings — a discreet brand-purple
// accent that makes the 1 → 2 → 3 flow readable at a glance.
function StepNumber({ n }: { n: number }) {
  return (
    <span
      className="flex items-center justify-center shrink-0"
      style={{ width: '18px', height: '18px', borderRadius: '50%', background: 'var(--accent-ink)', color: '#ffffff', fontSize: '10px', fontWeight: 500 }}
    >
      {n}
    </span>
  )
}

export function BucketWorkshopTab({ feedId, bucketId }: { feedId: string; bucketId: string }) {
  const [instructions, setInstructions] = useState('')
  const [inputFields, setInputFields] = useState<string[]>([])
  const [metafields, setMetafields] = useState<MetafieldOption[] | undefined>(undefined)
  const [examples, setExamples] = useState<BucketExample[]>([])
  // Validation verdicts from the latest generation (not persisted — id → result).
  const [validationById, setValidationById] = useState<Record<string, ValidationResult>>({})

  const [pickerOpen, setPickerOpen] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [savingConfig, setSavingConfig] = useState(false)
  const [savedConfig, setSavedConfig] = useState(false)
  // Tracks unsaved config edits (instructions / input fields) so the Save control
  // can surface an "unsaved changes" state and stay easy to find.
  const [dirty, setDirty] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [unusedLeft, setUnusedLeft] = useState<number | null>(null)
  // Original title + resolved input-field values of the product this round's
  // candidates are all built from — shown above them as a fixed reference point
  // ("same product, five ways") and as a grounding check for the curator.
  const [roundContext, setRoundContext] = useState<{ title: string; fields: { token: string; value: string }[] }>({
    title: '',
    fields: [],
  })
  const [error, setError] = useState<string | null>(null)

  // Initial load — config + metafields + examples. setState only in callbacks.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      getBucketTitleConfig(feedId, bucketId),
      getFeedMetafields(feedId),
      listBucketExamples(feedId, bucketId),
    ]).then(([cfg, mf, ex]) => {
      if (cancelled) return
      if ('data' in cfg) {
        setInstructions(cfg.data.instructions)
        setInputFields(cfg.data.input_fields)
      }
      if ('data' in mf) setMetafields(mf.data)
      if ('data' in ex) setExamples(ex.data)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId])

  // Close the field picker on outside click.
  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const approved = useMemo(
    () => examples.filter((e) => e.status === 'approved').sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [examples]
  )
  const candidates = useMemo(() => examples.filter((e) => e.status === 'candidate'), [examples])
  const rejected = useMemo(() => examples.filter((e) => e.status === 'rejected'), [examples])

  // This round's candidates all share one product_ref — fetch that product's
  // current title for the round header (works both right after generation and on
  // a later reload, since it's keyed off the persisted candidates).
  const roundProductRef = candidates[0]?.product_ref ?? null
  // Clear the round header when the round goes away. Done during render (React's
  // "adjust state when a prop changes" pattern) instead of inside the effect.
  const [prevRoundProductRef, setPrevRoundProductRef] = useState(roundProductRef)
  if (roundProductRef !== prevRoundProductRef) {
    setPrevRoundProductRef(roundProductRef)
    if (!roundProductRef) setRoundContext({ title: '', fields: [] })
  }
  useEffect(() => {
    if (!roundProductRef) return
    let cancelled = false
    getRoundProductContext(feedId, bucketId, roundProductRef).then((r) => {
      if (!cancelled && 'data' in r) setRoundContext(r.data)
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId, roundProductRef])

  // Mark config dirty (unsaved) — called from every instructions/field edit.
  function markDirty() {
    setSavedConfig(false)
    setDirty(true)
  }

  async function refreshExamples() {
    const r = await listBucketExamples(feedId, bucketId)
    if ('data' in r) setExamples(r.data)
  }

  async function persistConfig(): Promise<boolean> {
    const r = await saveBucketTitleConfig(feedId, bucketId, { instructions, input_fields: inputFields })
    if (r.error) {
      setError(r.error)
      return false
    }
    return true
  }

  async function handleSaveConfig() {
    setError(null)
    setSavingConfig(true)
    if (await persistConfig()) {
      setDirty(false)
      setSavedConfig(true)
      setTimeout(() => setSavedConfig(false), 2500)
    }
    setSavingConfig(false)
  }

  // All selectable field tokens (standard + feed metafields), for the checkbox
  // dropdown. Order here is just display order; priority is the inputFields order.
  const allFields = useMemo(
    () => [
      ...STANDARD_FIELDS.map((f) => f.value),
      ...(metafields ?? []).map((m) => `metafield:${m.namespace}.${m.key}`),
    ],
    [metafields]
  )

  function toggleField(token: string) {
    setInputFields((p) => (p.includes(token) ? p.filter((t) => t !== token) : [...p, token]))
    markDirty()
  }
  function removeField(token: string) {
    setInputFields((p) => p.filter((t) => t !== token))
    markDirty()
  }
  // Reorder the selected (priority) list — moves the dragged item to a new index.
  function moveField(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return
    setInputFields((p) => {
      const next = [...p]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    markDirty()
  }

  async function handleGenerate() {
    setError(null)
    setGenerating(true)
    // Persist the current config first so generation uses the latest instructions
    // and input fields (mirrors the scope tab's save-then-act).
    if (!(await persistConfig())) {
      setGenerating(false)
      return
    }
    setDirty(false)
    const r = await generateBucketCandidates(feedId, bucketId)
    if ('error' in r) {
      setError(r.error)
      setGenerating(false)
      return
    }
    setValidationById((prev) => {
      const next = { ...prev }
      for (const c of r.data.candidates) next[c.id] = c.validation
      return next
    })
    setUnusedLeft(r.data.unusedMembersAfter)
    await refreshExamples()
    setGenerating(false)
  }

  // Optimistic approve: move the example to "approved" (and bump the approved
  // count) in the UI immediately, then persist. On a failed save, roll THIS example
  // back to its prior status/position by id — so concurrent optimistic changes to
  // other examples are preserved — and surface a clear, reverted-state error.
  async function approveExample(id: string) {
    const prev = examples.find((e) => e.id === id)
    if (!prev || prev.status === 'approved') return
    setError(null)
    setExamples((cur) => applyApprove(cur, id))
    const r = await setBucketExampleStatus(feedId, bucketId, id, 'approved')
    if (r.error) {
      setExamples((cur) => revertStatus(cur, id, prev.status, prev.position))
      setError(`Kunne ikke godkende. Ændringen er rullet tilbage. ${r.error}`)
    }
  }

  // Optimistic delete: remove from the UI immediately, then persist. On failure,
  // restore the removed example near its original spot and show the error.
  async function removeExample(id: string) {
    const prev = examples.find((e) => e.id === id)
    if (!prev) return
    const prevIndex = examples.findIndex((e) => e.id === id)
    setError(null)
    setExamples((cur) => applyDelete(cur, id))
    const r = await deleteBucketExample(feedId, bucketId, id)
    if (r.error) {
      setExamples((cur) => restoreDeleted(cur, prev, prevIndex))
      setError(`Kunne ikke slette. Eksemplet er gendannet. ${r.error}`)
    }
  }

  const approvedFull = approved.length >= MAX_APPROVED

  if (loading) return <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>Henter…</p>

  return (
    <div className="space-y-3">
      {error && <div style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{error}</div>}

      {/* Step heading — names the task and lays out the three-step flow below. */}
      <div>
        <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent-ink)' }}>
          Eksempler
        </div>
        <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--color-text-primary)', letterSpacing: '-0.01em', lineHeight: 1.2, marginTop: '3px' }}>
          Lær AI’en at skrive titler
        </h2>
        <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginTop: '6px', maxWidth: '70ch' }}>
          Tre trin: <strong style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>1</strong> skriv dine instruktioner,{' '}
          <strong style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>2</strong> generér 5 forskellige bud, og{' '}
          <strong style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>3</strong> godkend dem, du kan lide (højst {MAX_APPROVED}).
          Når du kører bucketen, bruger AI’en dine godkendte eksempler, instruktioner og inputfelter.
        </p>
      </div>

      {/* 50/50: left = config (instructions + field picker), right = the workflow
          (generate, candidates, approved, history). Stacks on narrow screens. */}
      <div className="flex flex-col lg:flex-row gap-3 items-start">
        {/* Left 50% */}
        <div className="w-full lg:w-1/2 space-y-3">

      {/* Config: instructions + input fields.
          overflow:visible so the field dropdown can spill past the card (the
          shared .ff-panel clips with overflow:hidden otherwise). */}
      <div className="ff-panel" style={{ overflow: 'visible' }}>
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
          <span className="flex items-center gap-2" style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
            <StepNumber n={1} /> Skriv dine instruktioner
          </span>
          {dirty && (
            <span className="ff-badge ff-badge-warning shrink-0" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Ikke gemt
            </span>
          )}
        </div>
        <div className="p-3.5 space-y-3">
          <div>
            <label className="ff-label">Instruktioner</label>
            <textarea
              value={instructions}
              onChange={(e) => {
                setInstructions(e.target.value)
                markDirty()
              }}
              rows={3}
              placeholder="Fx: Brand først. Tag årgang med, hvis den findes. Hold titlen kort og søgbar."
              className="ff-input w-full"
              style={{ resize: 'vertical' }}
            />
          </div>

          <div>
            <label className="ff-label">Vælg felter, AI’en må bruge til titlen</label>

            {/* Checkbox dropdown: pick/unpick many fields at once. */}
            <div ref={pickerRef} style={{ position: 'relative', maxWidth: '320px' }}>
              <button type="button" onClick={() => setPickerOpen((o) => !o)} className="ff-select w-full text-left">
                {inputFields.length ? `${inputFields.length.toLocaleString('da-DK')} ${inputFields.length > 1 ? 'felter' : 'felt'} valgt` : 'Vælg felter…'}
              </button>
              {pickerOpen && (
                <div
                  className="ff-panel"
                  style={{ position: 'absolute', zIndex: 50, top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: '240px', overflowY: 'auto', padding: '6px' }}
                >
                  {allFields.map((token) => (
                    <label
                      key={token}
                      className="flex items-center gap-2 px-1.5 py-1 rounded"
                      style={{ fontSize: '11px', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                    >
                      <input type="checkbox" checked={inputFields.includes(token)} onChange={() => toggleField(token)} />
                      {fieldLabel(token, metafields)}
                    </label>
                  ))}
                  {allFields.length === 0 && (
                    <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', padding: '4px' }}>Ingen felter at vælge.</p>
                  )}
                </div>
              )}
            </div>

            {/* Ordered priority list — drag to reorder. */}
            <div className="mt-2 space-y-1">
              {inputFields.length === 0 ? (
                <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>Ingen. Kun den nuværende titel bruges.</span>
              ) : (
                inputFields.map((t, i) => (
                  <div
                    key={t}
                    draggable
                    onDragStart={() => setDragIndex(i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) moveField(dragIndex, i)
                      setDragIndex(null)
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className="flex items-center gap-2"
                    style={{
                      fontSize: '11px',
                      padding: '4px 8px',
                      border: '1px solid var(--color-border-secondary)',
                      borderRadius: '5px',
                      background: dragIndex === i ? 'var(--color-border-tertiary)' : 'transparent',
                      cursor: 'grab',
                    }}
                  >
                    <span style={{ color: 'var(--color-text-tertiary)' }}><GripIcon /></span>
                    <span className="ff-badge ff-badge-neutral shrink-0" style={{ textTransform: 'none', letterSpacing: 0 }}>{i + 1}</span>
                    <span className="flex-1 min-w-0" style={{ color: 'var(--color-text-primary)' }}>{fieldLabel(t, metafields)}</span>
                    <button type="button" onClick={() => removeField(t)} className="ff-btn-ghost shrink-0 w-5 h-5" aria-label="Fjern felt">×</button>
                  </div>
                ))
              )}
            </div>

            <p className="mt-1.5" style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
              Felterne er en ønskeliste: AI’en tager et felt med, når varen har det, i den rækkefølge du har valgt, og finder aldrig på et felt, der mangler.
              En vare skal bare have en titel og én egenskab (brand/varetype eller et valgt felt) for at kunne bruges.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveConfig}
              disabled={savingConfig || (!dirty && !savedConfig)}
              className={dirty ? 'ff-btn-primary' : 'ff-btn-secondary'}
            >
              {savingConfig ? 'Gemmer…' : savedConfig ? 'Gemt ✓' : dirty ? 'Gem indstillinger' : 'Gemt'}
            </button>
            {dirty && (
              <span style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
                Du har ændringer, der ikke er gemt.
              </span>
            )}
          </div>
        </div>
      </div>
        </div>
        {/* Right 50% */}
        <div className="w-full lg:w-1/2 space-y-3">

      {/* Step 2 — Generate. On top because it's the action you come here to do; the
          approved set below fills up afterward. */}
      <div className="ff-panel">
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
          <span className="flex items-center gap-2" style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
            <StepNumber n={2} /> Generér bud
          </span>
        </div>
        <div className="p-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <button onClick={handleGenerate} disabled={generating} className="ff-btn-primary">
              {generating
                ? 'Genererer…'
                : examples.length === 0
                  ? 'Generér titelbud'
                  : 'Generér flere bud'}
            </button>
            <span style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
              {approved.length} godkendt{approved.length ? ' (de tilgange undgås i næste runde)' : ''}
              {unusedLeft !== null ? ` · ${unusedLeft.toLocaleString('da-DK')} varer tilbage` : ''}
            </span>
          </div>
          <p style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
            En ny runde giver 5 nye bud. De bud, du ikke valgte i sidste runde, lægges til side.
          </p>
          {approvedFull && (
            <p style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
              Du har {MAX_APPROVED} godkendte eksempler. Slet et nedenfor, før du kan godkende flere.
            </p>
          )}
        </div>
      </div>

      {/* Approved examples (few-shot) — fills up as you approve from each round. */}
      <div className="ff-panel">
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
          Godkendte eksempler: {approved.length}/{MAX_APPROVED}
        </div>
        <div className="p-3.5 space-y-1.5">
          {approved.length === 0 ? (
            <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              Ingen endnu. Generér bud ovenfor, og godkend de gode.
            </p>
          ) : (
            approved.map((e) => (
              <div key={e.id} className="flex items-start gap-2" style={{ fontSize: '11px' }}>
                <span className="ff-badge ff-badge-success shrink-0">#{(e.position ?? 0) + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span style={{ color: 'var(--color-text-primary)' }}>{e.generated_title}</span>
                    {e.approach && (
                      <span className="ff-badge ff-badge-neutral shrink-0" style={{ textTransform: 'none', letterSpacing: 0 }}>{e.approach}</span>
                    )}
                  </div>
                  {e.rationale && <div style={{ color: 'var(--color-text-tertiary)' }}>{e.rationale}</div>}
                </div>
                <button
                  type="button"
                  onClick={() => removeExample(e.id)}
                  className="ff-btn-ghost shrink-0 w-6 h-6"
                  aria-label="Slet eksempel (giver plads til et nyt)"
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Candidates to curate — this round's 5 approaches. Selecting = approve. */}
      {candidates.length > 0 && (
        <div className="ff-panel">
          <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
            <span className="flex items-center gap-2" style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>
              <StepNumber n={3} /> Godkend dem, du kan lide
            </span>
          </div>
          <div className="p-3.5 space-y-2.5">
            {/* Same product, five ways — the original title is the fixed reference
                point the 5 approaches are compared against; the resolved input-field
                values below double as a grounding check (a title claiming something
                not listed here is a red flag). */}
            {roundContext.title && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: '5px',
                  background: 'var(--color-background-secondary)',
                  border: '1px solid var(--color-border-tertiary)',
                }}
              >
                <div style={{ fontSize: '9px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-tertiary)' }}>
                  Oprindelig titel. De 5 bud nedenfor er alle omskrivninger af den
                </div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--color-text-primary)', marginTop: '2px' }}>
                  {roundContext.title}
                </div>
                {roundContext.fields.length > 0 && (
                  <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '5px' }}>
                    {roundContext.fields.map((f, i) => (
                      <span key={f.token}>
                        {i > 0 && <span style={{ color: 'var(--color-text-tertiary)' }}> · </span>}
                        <span style={{ color: 'var(--color-text-tertiary)' }}>{fieldLabel(f.token, metafields, true)}: </span>
                        {f.value}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {candidates.map((e) => {
              const v = validationById[e.id]
              return (
                <label
                  key={e.id}
                  className="flex items-start gap-2"
                  style={{ fontSize: '11px', cursor: approvedFull ? 'not-allowed' : 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={false}
                    disabled={approvedFull}
                    onChange={() => approveExample(e.id)}
                    className="mt-0.5"
                    aria-label="Godkend dette bud"
                    title={approvedFull ? `Højst ${MAX_APPROVED} godkendte` : 'Godkend'}
                  />
                  <div className="flex-1 min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      {e.approach && (
                        <span className="ff-badge ff-badge-accent shrink-0" style={{ textTransform: 'none', letterSpacing: 0 }}>{e.approach}</span>
                      )}
                      <span style={{ color: 'var(--color-text-primary)' }}>{e.generated_title}</span>
                      {v && !v.ok && (
                        <span className="ff-badge ff-badge-warning" title={v.issues.map((i) => i.detail).join('; ')}>
                          {v.issues.map((i) => i.code).join(', ')}
                        </span>
                      )}
                    </div>
                    {e.rationale && <div style={{ color: 'var(--color-text-tertiary)' }}>{e.rationale}</div>}
                  </div>
                </label>
              )
            })}
          </div>
        </div>
      )}

      {/* Earlier candidates the curator didn't pick — kept as "not these" context. */}
      {rejected.length > 0 && (
        <details className="ff-panel">
          <summary
            className="ff-panel-header"
            style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px', cursor: 'pointer' }}
          >
            Ikke valgt: {rejected.length} fra tidligere runder
          </summary>
          <div className="p-3.5 space-y-1.5">
            {rejected.map((e) => (
              <div key={e.id} className="flex items-center gap-2" style={{ fontSize: '11px' }}>
                {e.approach && (
                  <span className="ff-badge ff-badge-neutral shrink-0" style={{ textTransform: 'none', letterSpacing: 0 }}>{e.approach}</span>
                )}
                <span className="flex-1 min-w-0" style={{ color: 'var(--color-text-secondary)', textDecoration: 'line-through' }}>{e.generated_title}</span>
                <button
                  type="button"
                  onClick={() => removeExample(e.id)}
                  className="ff-btn-ghost shrink-0 w-6 h-6"
                  aria-label="Slet fra historik"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
        </div>
      </div>

      {/* Sticky save bar — only while there are unsaved config changes, so it's
          reachable even when the config card is scrolled out of view. */}
      {dirty && (
        <div
          className="flex items-center justify-between gap-3"
          style={{
            position: 'sticky',
            bottom: '8px',
            zIndex: 25,
            padding: '8px 12px',
            borderRadius: '6px',
            background: 'var(--color-background-secondary)',
            border: '1px solid var(--color-border-secondary)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          }}
        >
          <span style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
            Du har ændringer i bucketens instruktioner eller inputfelter, der ikke er gemt.
          </span>
          <button onClick={handleSaveConfig} disabled={savingConfig} className="ff-btn-primary shrink-0">
            {savingConfig ? 'Gemmer…' : 'Gem indstillinger'}
          </button>
        </div>
      )}
    </div>
  )
}
