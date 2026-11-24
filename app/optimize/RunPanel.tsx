'use client'

import { useEffect, useState } from 'react'
import {
  getOptimizationOverlap,
  planOptimization,
  previewOptimization,
  runOptimizationForRefs,
} from './actions'
import type { OptimizationOutcome, TitleMethod } from '@/lib/titleOptimizer'
import type { OverlapSummary } from '@/lib/titleOptimizationScope'

const CHUNK = 10

// ── Outcome list ─────────────────────────────────────────────────────────────

function OutcomeList({ title, outcomes }: { title: string; outcomes: OptimizationOutcome[] }) {
  if (outcomes.length === 0) return null
  return (
    <div className="ff-panel">
      <div
        className="ff-panel-header"
        style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}
      >
        {title} ({outcomes.length.toLocaleString('da-DK')})
      </div>
      <div className="divide-y" style={{ borderColor: 'var(--color-border-tertiary)' }}>
        {outcomes.map((o) => {
          const ok = o.validation.ok
          return (
            <div key={o.product_ref} className="px-3.5 py-2.5">
              <div className="flex items-start gap-2">
                <span
                  className={`mt-0.5 shrink-0 ff-badge ${ok ? 'ff-badge-success' : 'ff-badge-warning'}`}
                >
                  {ok ? 'OK' : 'TJEK'}
                </span>
                <div className="min-w-0 flex-1">
                  <div style={{ fontSize: '12px', color: 'var(--color-text-primary)', fontWeight: 500 }}>
                    {o.proposed_title ?? '(intet svar)'}
                  </div>
                  <div className="mt-0.5 truncate" style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
                    før: {o.original_title}
                  </div>
                  {!ok && o.validation.issues.length > 0 && (
                    <div className="mt-1" style={{ fontSize: '10px', color: 'var(--color-badge-warning-text)' }}>
                      {o.validation.issues.map((i, idx) => (
                        <div key={idx}>• {i.detail}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── RunPanel ─────────────────────────────────────────────────────────────────

export function RunPanel({ feedId }: { feedId: string }) {
  const [method, setMethod] = useState<TitleMethod>('auto')
  const [error, setError] = useState<string | null>(null)

  // Preview (dry run)
  const [previewSize, setPreviewSize] = useState('10')
  const [previewing, setPreviewing] = useState(false)
  const [previewResults, setPreviewResults] = useState<OptimizationOutcome[]>([])

  // Overlap
  const [overlap, setOverlap] = useState<OverlapSummary | null>(null)
  const [loadingOverlap, setLoadingOverlap] = useState(true)

  // Run options + progress
  const [rerun, setRerun] = useState(false)
  const [includeHumanEdited, setIncludeHumanEdited] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [runResults, setRunResults] = useState<OptimizationOutcome[]>([])

  // Initial overlap load — inline promise chain so setState only happens inside
  // the async callback (the set-state-in-effect rule flags calling a
  // setState-containing function synchronously in an effect). loadingOverlap
  // starts true. refreshOverlap (below) is used after a run, from an event handler.
  useEffect(() => {
    let cancelled = false
    getOptimizationOverlap(feedId).then((r) => {
      if (cancelled) return
      if ('data' in r) setOverlap(r.data)
      else setError(r.error)
      setLoadingOverlap(false)
    })
    return () => {
      cancelled = true
    }
  }, [feedId])

  async function refreshOverlap() {
    const r = await getOptimizationOverlap(feedId)
    if ('data' in r) setOverlap(r.data)
    else setError(r.error)
    setLoadingOverlap(false)
  }

  async function handlePreview() {
    setError(null)
    setPreviewing(true)
    setPreviewResults([])
    const n = parseInt(previewSize, 10) || 10
    const r = await previewOptimization(feedId, method, n)
    if ('data' in r) setPreviewResults(r.data)
    else setError(r.error)
    setPreviewing(false)
  }

  async function handleRun() {
    setError(null)
    setRunning(true)
    setRunResults([])
    setProgress({ done: 0, total: 0 })

    const plan = await planOptimization(feedId, { rerun, includeHumanEdited })
    if ('error' in plan) {
      setError(plan.error)
      setRunning(false)
      return
    }
    const targets = plan.data.targets
    setProgress({ done: 0, total: targets.length })
    if (targets.length === 0) {
      setRunning(false)
      return
    }

    const all: OptimizationOutcome[] = []
    for (let i = 0; i < targets.length; i += CHUNK) {
      const chunk = targets.slice(i, i + CHUNK)
      const res = await runOptimizationForRefs(feedId, method, chunk)
      if ('error' in res) {
        setError(res.error)
        break
      }
      all.push(...res.data)
      setRunResults([...all])
      setProgress({ done: Math.min(i + CHUNK, targets.length), total: targets.length })
    }

    setRunning(false)
    refreshOverlap()
  }

  const methodBtn = (value: TitleMethod, label: string, desc: string) => {
    const isActive = method === value
    return (
      <button
        type="button"
        onClick={() => setMethod(value)}
        className="text-left p-3 flex-1"
        style={{
          border: `1px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border-secondary)'}`,
          borderRadius: '6px',
          background: isActive ? 'var(--color-accent-subtle, rgba(108,92,231,0.08))' : 'transparent',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</div>
        <div className="mt-0.5" style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>{desc}</div>
      </button>
    )
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="ff-panel" style={{ borderColor: 'var(--color-badge-danger-text)' }}>
          <div className="p-3" style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{error}</div>
        </div>
      )}

      {/* Method */}
      <div className="ff-panel">
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
          Metode
        </div>
        <div className="p-3.5 flex gap-2.5">
          {methodBtn('auto', 'Automatisk', 'Gennemprøvet opbygning uden regler. Kræver ingen opsætning.')}
          {methodBtn('rule_based', 'Regelbaseret', 'Bruger dine regler for egenskaber pr. varetype.')}
        </div>
      </div>

      {/* Preview (dry run) */}
      <div className="ff-panel">
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
          Test uden at gemme
        </div>
        <div className="p-3.5 space-y-2">
          <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
            Generér titler for et lille udsnit, og se hvad AI’en laver. Intet bliver gemt, så du kan justere
            indstillingerne og teste igen. Virker også, før du har tilføjet eksempler.
          </p>
          <div className="flex items-center gap-2">
            <label className="ff-label" style={{ margin: 0 }}>Antal varer</label>
            <input
              type="number"
              min={1}
              max={50}
              value={previewSize}
              onChange={(e) => setPreviewSize(e.target.value)}
              className="ff-input w-20"
            />
            <button onClick={handlePreview} disabled={previewing} className="ff-btn-secondary">
              {previewing ? 'Genererer…' : 'Test'}
            </button>
          </div>
        </div>
      </div>

      <OutcomeList title="Testresultater" outcomes={previewResults} />

      {/* Run (persist) */}
      <div className="ff-panel">
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
          Kør og gem
        </div>
        <div className="p-3.5 space-y-3">
          {loadingOverlap ? (
            <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>Beregner scope…</p>
          ) : overlap ? (
            <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
              <strong>{overlap.inScope.toLocaleString('da-DK')}</strong> varer i scope. Heraf er{' '}
              <strong>{overlap.alreadyOptimized.toLocaleString('da-DK')}</strong> allerede optimeret af AI
              {overlap.humanEdited > 0 ? <> (<strong>{overlap.humanEdited.toLocaleString('da-DK')}</strong> rettet i hånden)</> : null}
              {overlap.needsReview > 0 ? <>, {overlap.needsReview.toLocaleString('da-DK')} venter på godkendelse</> : null}.{' '}
              <strong>{overlap.notYetOptimized.toLocaleString('da-DK')}</strong> er ikke optimeret endnu.
            </p>
          ) : null}

          <div className="space-y-1.5">
            <label className="flex items-center gap-2" style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={rerun} onChange={(e) => setRerun(e.target.checked)} />
              Optimér også varer, der allerede har en AI-titel
            </label>
            <label
              className="flex items-center gap-2"
              style={{ fontSize: '11px', color: rerun ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', paddingLeft: '20px' }}
            >
              <input
                type="checkbox"
                checked={includeHumanEdited}
                disabled={!rerun}
                onChange={(e) => setIncludeHumanEdited(e.target.checked)}
              />
              Overskriv også titler, der er rettet i hånden{overlap && overlap.humanEdited > 0 ? ` (${overlap.humanEdited.toLocaleString('da-DK')})` : ''} — destruktivt
            </label>
          </div>

          {running && (
            <div className="space-y-1">
              <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                {progress.done.toLocaleString('da-DK')} af {progress.total.toLocaleString('da-DK')} optimeret…
              </div>
              <div style={{ height: '4px', background: 'var(--color-border-tertiary)', borderRadius: '2px', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: progress.total ? `${(progress.done / progress.total) * 100}%` : '0%',
                    background: 'var(--color-accent)',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </div>
          )}

          <button onClick={handleRun} disabled={running || loadingOverlap} className="ff-btn-primary">
            {running ? 'Kører…' : 'Kør optimering'}
          </button>
        </div>
      </div>

      <OutcomeList title="Resultater" outcomes={runResults} />
    </div>
  )
}
