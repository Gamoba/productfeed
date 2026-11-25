'use client'

import Link from 'next/link'

// The footer of the five feed setup pages (Mapping → Include / exclude →
// AI Titles → Labels → Preview & export): where you are, a way back and the
// way on. `onNext` is for pages that save first; otherwise `next.href` links.
export function SetupStepFooter({
  step,
  back,
  next,
  onNext,
  busy,
}: {
  step: number
  back: { href: string; label: string }
  next: { href: string; label: string }
  onNext?: () => void
  busy?: boolean
}) {
  return (
    <div className="setup-step">
      <span>Step {step} of 5 in setting up the feed</span>
      <Link href={back.href} className="wl-btn-secondary">
        {back.label}
      </Link>
      {onNext ? (
        <button type="button" className="wl-btn-primary" onClick={onNext} disabled={busy}>
          {next.label}
        </button>
      ) : (
        <Link href={next.href} className="wl-btn-primary">
          {next.label}
        </Link>
      )}
    </div>
  )
}
