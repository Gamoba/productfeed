'use client'

// One bucket as a guided step-flow: Scope → Teach (examples) → Run (+ results).
// Steps are freely navigable — click the stepper, or Back/Next in the footer —
// but the order communicates the intended path. Step 1 (Buckets) is the
// overview page; the shared stepper links back to it.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { getBucketMembership } from './actions'
import { BucketScopeTab } from './BucketScopeTab'
import { BucketRunTab, type RunControl } from './BucketRunTab'
import { BucketWorkshopTab } from './BucketWorkshopTab'
import { BucketResultsPanel } from './BucketResultsPanel'
import { BucketCustomLabelPanel } from './BucketCustomLabelPanel'
import { TitleSteps, TITLE_STEPS } from './TitleSteps'
import type { FilterConfig } from '@/app/filters/actions'
import { formatNumber } from '@/lib/formatDa'
import './optimize.css'

type Step = 'scope' | 'examples' | 'run'
const ORDER: Step[] = ['scope', 'examples', 'run']

const LEDE: Record<Step, string> = {
  scope: 'Vælg hvilke varer der hører til gruppen. Reglerne virker som på Inkludér / ekskludér.',
  examples: 'Skriv instruktioner, vælg de felter AI’en må bruge, og giv den eksempler på titler, du kan lide.',
  run: 'Kør optimeringen, og godkend titlerne. Intet går live, før du har godkendt det.',
}

export function BucketEditorClient({
  feedId,
  bucketId,
  bucketName,
  initialInclude,
  initialExclude,
}: {
  feedId: string
  bucketId: string
  bucketName: string
  initialInclude: FilterConfig
  initialExclude: FilterConfig
}) {
  const [step, setStep] = useState<Step>('scope')
  // Membership count drives the soft "set scope first" nudge. null = loading.
  const [memberCount, setMemberCount] = useState<number | null>(null)
  // Bumped after a run so the Results panel reloads with the new titles.
  const [resultsKey, setResultsKey] = useState(0)
  // Run trigger + state, reported up by BucketRunTab so the footer can host
  // the "Kør optimering" button on the Run step.
  const [runControl, setRunControl] = useState<RunControl | null>(null)

  // Re-read on every step change: Scope commits membership without remounting.
  useEffect(() => {
    let cancelled = false
    getBucketMembership(feedId, bucketId).then((r) => {
      if (!cancelled && 'data' in r) setMemberCount(r.data.length)
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId, step])

  const noMembers = memberCount === 0
  const at = ORDER.indexOf(step)
  const prev = at > 0 ? ORDER[at - 1] : null
  const next = at < ORDER.length - 1 ? ORDER[at + 1] : null
  const labelOf = (s: Step) => TITLE_STEPS.find((t) => t.id === s)?.label ?? s

  return (
    <div className="ts">
      <div className="ts-head">
        <div>
          <p className="ts-crumb">
            <Link href={`/feed/${feedId}/optimize`}>AI Titles</Link> › gruppe
          </p>
          <h1>{bucketName}</h1>
          <p className="ts-lede">
            {memberCount !== null &&
              `${formatNumber(memberCount)} ${memberCount === 1 ? 'vare' : 'varer'} i gruppen. `}
            {LEDE[step]}
          </p>
        </div>
      </div>

      <TitleSteps current={step} feedId={feedId} onStep={setStep} />

      {noMembers && step !== 'scope' && (
        <p className="note">
          Gruppen har ingen varer endnu. Vælg dem under Scope, så AI’en har noget at arbejde med.
        </p>
      )}

      {/* All steps stay mounted; only visibility toggles, so unsaved state in a
          step (instructions, the inspected product) survives switching away. */}
      <div className="ts-stack" style={{ display: step === 'scope' ? undefined : 'none' }}>
        <BucketScopeTab feedId={feedId} bucketId={bucketId} initialInclude={initialInclude} initialExclude={initialExclude} />
        <BucketCustomLabelPanel feedId={feedId} bucketId={bucketId} />
      </div>
      <div className="ts-stack" style={{ display: step === 'examples' ? undefined : 'none' }}>
        <BucketWorkshopTab feedId={feedId} bucketId={bucketId} />
      </div>
      <div className="ts-stack" style={{ display: step === 'run' ? undefined : 'none' }}>
        <BucketRunTab
          feedId={feedId}
          bucketId={bucketId}
          onRunComplete={() => setResultsKey((k) => k + 1)}
          onRunControlChange={setRunControl}
          isActive={step === 'run'}
        />
        <BucketResultsPanel feedId={feedId} bucketId={bucketId} reloadKey={resultsKey} isActive={step === 'run'} />
      </div>

      {/* Step footer, sticky so Back/Next stay in reach on long steps. */}
      <div className="ts-foot">
        <span>
          Trin {at + 2} af 4 · {labelOf(step)}
        </span>
        {prev ? (
          <button type="button" onClick={() => setStep(prev)} className="wl-btn-secondary">
            Tilbage til {labelOf(prev)}
          </button>
        ) : (
          <Link href={`/feed/${feedId}/optimize`} className="wl-btn-secondary">
            Tilbage til Buckets
          </Link>
        )}
        {step === 'run' ? (
          <button
            type="button"
            onClick={() => runControl?.run()}
            disabled={!runControl || runControl.disabled}
            className="wl-btn-primary"
          >
            {runControl?.running ? 'Kører…' : 'Kør optimering'}
          </button>
        ) : next ? (
          <button type="button" onClick={() => setStep(next)} className="wl-btn-primary">
            Videre til {labelOf(next)}
          </button>
        ) : null}
      </div>
    </div>
  )
}
