'use client'

import Link from 'next/link'

// The AI Titles flow as one stepper, shared by the bucket overview (step 1)
// and the bucket editor (steps 2–4). Reference: the prototype's
// "Buckets › Scope › Teach › Run". Steps link or call back; done steps show ✓.

export type TitleStep = 'buckets' | 'scope' | 'examples' | 'run'

export const TITLE_STEPS: { id: TitleStep; label: string; sub: string }[] = [
  { id: 'buckets', label: 'Buckets', sub: 'Vælg gruppe' },
  { id: 'scope', label: 'Scope', sub: 'Vælg varer' },
  { id: 'examples', label: 'Teach', sub: 'Lær AI’en stilen' },
  { id: 'run', label: 'Run', sub: 'Kør og godkend' },
]

export function TitleSteps({
  current,
  feedId,
  onStep,
}: {
  current: TitleStep
  feedId: string
  // Steps 2–4 belong to one bucket; without onStep they are shown but inert.
  onStep?: (s: Exclude<TitleStep, 'buckets'>) => void
}) {
  const at = TITLE_STEPS.findIndex((s) => s.id === current)
  return (
    <ol className="ts-steps" aria-label="Trin i AI Titles">
      {TITLE_STEPS.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'todo'
        const body = (
          <>
            <i>{state === 'done' ? '✓' : i + 1}</i>
            <span>
              <b>{s.label}</b>
              <small>{s.sub}</small>
            </span>
          </>
        )
        return (
          <li key={s.id} className={`ts-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            {s.id === 'buckets' && current !== 'buckets' ? (
              <Link href={`/feed/${feedId}/optimize`}>{body}</Link>
            ) : s.id !== 'buckets' && onStep ? (
              <button type="button" onClick={() => onStep(s.id as Exclude<TitleStep, 'buckets'>)}>
                {body}
              </button>
            ) : (
              <span className="ts-inert">{body}</span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
