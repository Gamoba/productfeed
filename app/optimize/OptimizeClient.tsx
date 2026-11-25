'use client'

import { SetupStepFooter } from '@/app/components/SetupStepFooter'
import { useState } from 'react'
import { BucketListPanel } from './BucketListPanel'
import { SettingsPanel } from './SettingsPanel'
import { TitleSteps } from './TitleSteps'
import type { OptimizationSettings } from '@/lib/titleOptimizationService'
import type { BucketSummary } from '@/lib/optimizationBuckets'
import './optimize.css'

type Tab = 'buckets' | 'settings'

// Feed › AI Titles, step 1: the buckets (groups of products that share one
// title style). Opening a bucket continues with Scope, Teach and Run.
export function OptimizeClient({
  feedId,
  initialSettings,
  initialBuckets,
}: {
  feedId: string
  initialSettings: OptimizationSettings
  initialBuckets: BucketSummary[]
}) {
  const [tab, setTab] = useState<Tab>('buckets')

  return (
    <div className="ts">
      <div className="ts-head">
        <div>
          <h1>AI Titles</h1>
          <p className="ts-lede">
            Del varerne i grupper, lær AI’en stilen for hver gruppe, og godkend titlerne. Du godkender
            altid, før noget går live.
          </p>
        </div>
        <div className="ts-seg" role="tablist" aria-label="Visning">
          {(
            [
              ['buckets', 'Buckets'],
              ['settings', 'Indstillinger'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'buckets' ? (
        <>
          <TitleSteps current="buckets" feedId={feedId} />
          <BucketListPanel feedId={feedId} initialBuckets={initialBuckets} />
        </>
      ) : (
        <section className="card">
          <SettingsPanel feedId={feedId} initialSettings={initialSettings} />
        </section>
      )}

      <SetupStepFooter
        step={3}
        back={{ href: `/feed/${feedId}/filters`, label: 'Tilbage til Inkludér / ekskludér' }}
        next={{ href: `/feed/${feedId}/google-ads/labels`, label: 'Videre til Labels' }}
      />
    </div>
  )
}
