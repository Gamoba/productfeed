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
  scope: 'Choose which products belong to the bucket. The rules work as on Include / exclude.',
  examples: 'Write instructions, choose the fields the AI may use, and give it examples of titles you like.',
  run: 'Run the optimisation and approve the titles. Nothing goes live until you have approved it.',
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
            <Link href={`/feed/${feedId}/optimize`}>AI Titles</Link> › bucket
          </p>
          <h1>{bucketName}</h1>
          <p className="ts-lede">
            {memberCount !== null &&
              `${formatNumber(memberCount)} ${memberCount === 1 ? 'product' : 'products'} in the bucket. `}
            {LEDE[step]}
          </p>
        </div>
      </div>

      <TitleSteps current={step} feedId={feedId} onStep={setStep} />

      {noMembers && step !== 'scope' && (
        <p className="note">
          The bucket has no products yet. Choose them under Scope so the AI has something to work with.
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
          Step {at + 2} of 4 · {labelOf(step)}
        </span>
        {prev ? (
          <button type="button" onClick={() => setStep(prev)} className="wl-btn-secondary">
            Back to {labelOf(prev)}
          </button>
        ) : (
          <Link href={`/feed/${feedId}/optimize`} className="wl-btn-secondary">
            Back to Buckets
          </Link>
        )}
        {step === 'run' ? (
          <button
            type="button"
            onClick={() => runControl?.run()}
            disabled={!runControl || runControl.disabled}
            className="wl-btn-primary"
          >
            {runControl?.running ? 'Running…' : 'Run optimisation'}
          </button>
        ) : next ? (
          <button type="button" onClick={() => setStep(next)} className="wl-btn-primary">
            Continue to {labelOf(next)}
          </button>
        ) : null}
      </div>
    </div>
  )
}
