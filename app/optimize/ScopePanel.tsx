'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  saveOptimizationFilters,
  getOptimizationOverlapForFilters,
} from './actions'
import { FilterSection, defaultRule } from '@/app/components/FilterEditor'
import type { FilterRule, FilterConfig } from '@/app/filters/actions'
import type { OverlapSummary } from '@/lib/titleOptimizationScope'

export function ScopePanel({
  feedId,
  initialInclude,
  initialExclude,
}: {
  feedId: string
  initialInclude: FilterConfig
  initialExclude: FilterConfig
}) {
  const [include, setInclude] = useState<FilterConfig>(initialInclude)
  const [exclude, setExclude] = useState<FilterConfig>(initialExclude)

  const [summary, setSummary] = useState<OverlapSummary | null>(null)
  const [recalculating, setRecalculating] = useState(false)

  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  // Debounced live overlap as the filter changes — same applyFeedFilters as a
  // real run. setState only happens inside the timeout/promise (async), so the
  // set-state-in-effect rule is satisfied.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(() => {
      setRecalculating(true)
      getOptimizationOverlapForFilters(feedId, include, exclude).then((r) => {
        if (cancelled) return
        if ('data' in r) setSummary(r.data)
        else setError(r.error)
        setRecalculating(false)
      })
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [feedId, include, exclude])

  function addRule(type: 'include' | 'exclude') {
    const setter = type === 'include' ? setInclude : setExclude
    setter((prev) => ({ ...prev, rules: [...prev.rules, defaultRule()] }))
  }
  function removeRule(type: 'include' | 'exclude', idx: number) {
    const setter = type === 'include' ? setInclude : setExclude
    setter((prev) => ({ ...prev, rules: prev.rules.filter((_, i) => i !== idx) }))
  }
  function updateRule(type: 'include' | 'exclude', idx: number, patch: Partial<FilterRule>) {
    const setter = type === 'include' ? setInclude : setExclude
    setter((prev) => ({ ...prev, rules: prev.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)) }))
  }
  function setOperator(type: 'include' | 'exclude', op: 'AND' | 'OR') {
    const setter = type === 'include' ? setInclude : setExclude
    setter((prev) => ({ ...prev, operator: op }))
  }

  function handleSave() {
    setError(null)
    setSuccess(false)
    startTransition(async () => {
      const result = await saveOptimizationFilters(feedId, include, exclude)
      if (result.error) setError(result.error)
      else {
        setSuccess(true)
        setTimeout(() => setSuccess(false), 3000)
      }
    })
  }

  return (
    <div className="space-y-3">
      {/* Scope summary + save */}
      <div className="ff-panel">
        <div className="p-3.5 flex items-center justify-between gap-3">
          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
            {summary ? (
              <>
                <strong style={{ color: 'var(--color-text-primary)' }}>{summary.inScope.toLocaleString('da-DK')}</strong> varer i scope
                {summary.alreadyOptimized + summary.humanEdited + summary.needsReview > 0 && (
                  <span style={{ color: 'var(--color-text-tertiary)' }}>
                    {' '}· {summary.alreadyOptimized.toLocaleString('da-DK')} optimeret af AI
                    {summary.humanEdited > 0 ? `, ${summary.humanEdited.toLocaleString('da-DK')} rettet i hånden` : ''}
                    {summary.needsReview > 0 ? `, ${summary.needsReview.toLocaleString('da-DK')} til godkendelse` : ''}
                    {`, ${summary.notYetOptimized.toLocaleString('da-DK')} nye`}
                  </span>
                )}
                {recalculating && <span style={{ color: 'var(--color-text-tertiary)' }}> · opdaterer…</span>}
              </>
            ) : (
              <span style={{ color: 'var(--color-text-tertiary)' }}>Beregner scope…</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {error && <span style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{error}</span>}
            <button onClick={handleSave} disabled={isPending} className="ff-btn-primary">
              {isPending ? 'Gemmer…' : success ? 'Gemt' : 'Gem scope'}
            </button>
          </div>
        </div>
      </div>

      <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
        Dette filter er adskilt fra feedets Inkludér / ekskludér. Det afgør kun, hvilke varer en
        optimering <em>kører</em> på. Gem det, og kør derefter fra Run.
      </p>

      <FilterSection
        title="Inkludér varer"
        description="Kun varer, der matcher reglerne, bliver optimeret. Ingen regler betyder alle varer i feedet."
        badge="INKLUDÉR"
        badgeCls="ff-badge ff-badge-success"
        config={include}
        onAddRule={() => addRule('include')}
        onRemoveRule={(i) => removeRule('include', i)}
        onUpdateRule={(i, p) => updateRule('include', i, p)}
        onSetOperator={(op) => setOperator('include', op)}
      />
      <FilterSection
        title="Ekskludér varer"
        description="Varer, der matcher reglerne, fjernes fra optimeringen."
        badge="EKSKLUDÉR"
        badgeCls="ff-badge ff-badge-danger"
        config={exclude}
        onAddRule={() => addRule('exclude')}
        onRemoveRule={(i) => removeRule('exclude', i)}
        onUpdateRule={(i, p) => updateRule('exclude', i, p)}
        onSetOperator={(op) => setOperator('exclude', op)}
      />
    </div>
  )
}
