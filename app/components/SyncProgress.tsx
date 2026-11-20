'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SyncResult } from '@/lib/sync'
import type { SyncStatus } from '@/lib/syncProgress'

// Client side of a feed's product sync: starts it, and follows its progress by
// polling GET /api/feeds/[feedId]/sync-status. The progress lives on the feed
// row, not in this page — so a sync started elsewhere (another tab, the cron,
// the new-feed wizard) is picked up on mount, and leaving the page loses
// nothing.

const POLL_MS = 1500

export type FeedSync = {
  /** null until the first status read lands. */
  status: SyncStatus | null
  running: boolean
  /** Starts a sync, or attaches to the one already running (409). */
  start: () => Promise<void>
}

export async function fetchSyncStatus(feedId: string): Promise<SyncStatus | null> {
  try {
    const res = await fetch(`/api/feeds/${encodeURIComponent(feedId)}/sync-status`, { cache: 'no-store' })
    return res.ok ? ((await res.json()) as SyncStatus) : null
  } catch {
    return null
  }
}

export function useFeedSync(
  feedId: string,
  opts: {
    /** Called once when a sync this hook followed ends — ok or not. */
    onFinished?: (outcome: { ok: true; result: SyncResult | null } | { ok: false; error: string }) => void
  } = {}
): FeedSync {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [polling, setPolling] = useState(false)
  // The POST's own result, when this tab started the sync — it carries counts
  // and warnings the status row doesn't.
  const resultRef = useRef<SyncResult | null>(null)
  // This tab's POST, while one is in flight. Two races hang on it:
  //  • before the server has claimed the feed, the row still shows the
  //    PREVIOUS sync ('ok'/'idle') — that must not read as "finished";
  //  • the row flips to 'ok' a moment before the POST returns its result.
  const postRef = useRef<Promise<void> | null>(null)
  const postPendingRef = useRef(false)
  const sawRunningRef = useRef(false)
  // Latest callback without re-subscribing the poll every render.
  const onFinishedRef = useRef(opts.onFinished)
  useEffect(() => {
    onFinishedRef.current = opts.onFinished
  })

  // Resume on mount: a sync may already be running from somewhere else.
  useEffect(() => {
    let cancelled = false
    void fetchSyncStatus(feedId).then((s) => {
      if (cancelled || !s || postPendingRef.current) return
      setStatus(s)
      if (s.status === 'running') {
        sawRunningRef.current = true
        setPolling(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [feedId])

  // Poll while running; stop and report when the row says it's over.
  useEffect(() => {
    if (!polling) return
    let cancelled = false
    let finishing = false
    const tick = async () => {
      if (finishing) return
      const s = await fetchSyncStatus(feedId)
      if (cancelled || !s || finishing) return
      if (s.status === 'running') {
        sawRunningRef.current = true
        setStatus(s)
        return
      }
      // Not running, and our POST hasn't been seen running nor returned yet:
      // the row is still the previous sync's. Keep the optimistic bar.
      if (postPendingRef.current && !sawRunningRef.current) return
      finishing = true
      if (postRef.current) await postRef.current
      if (cancelled) return
      postRef.current = null
      setStatus(s)
      setPolling(false)
      const result = resultRef.current
      resultRef.current = null
      onFinishedRef.current?.(
        s.status === 'error'
          ? { ok: false, error: s.error ?? 'The sync failed.' }
          : { ok: true, result }
      )
    }
    const id = setInterval(tick, POLL_MS)
    void tick()
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [feedId, polling])

  const start = useCallback(async () => {
    resultRef.current = null
    sawRunningRef.current = false
    postPendingRef.current = true
    // Optimistic: the bar appears at once instead of after the first poll.
    setStatus({
      status: 'running',
      progress: 0,
      phase: 'Starting',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    })
    setPolling(true)
    const post = (async () => {
      try {
        const res = await fetch(`/api/shopify/sync?feedId=${encodeURIComponent(feedId)}`, { method: 'POST' })
        if (res.ok) {
          resultRef.current = (await res.json()) as SyncResult
        } else if (res.status !== 409) {
          // Refused before it started (rate limit, missing connection, …) or
          // failed outright. 409 needs nothing: a sync is running and the poll
          // is following it.
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          const error = body.error ?? `The sync could not start (HTTP ${res.status}).`
          // If the row never showed OUR sync running, it never claimed the
          // feed — report the refusal directly instead of waiting on the row.
          if (!sawRunningRef.current) {
            setPolling(false)
            setStatus((prev) => ({
              status: 'error',
              progress: 0,
              phase: null,
              startedAt: prev?.startedAt ?? null,
              finishedAt: new Date().toISOString(),
              error,
            }))
            postRef.current = null
            onFinishedRef.current?.({ ok: false, error })
          }
        }
      } catch {
        // A dropped connection doesn't mean a dead sync — the server keeps
        // going, and the poll reports how it really ended.
      } finally {
        postPendingRef.current = false
      }
    })()
    postRef.current = post
    await post
  }, [feedId])

  return { status, running: status?.status === 'running', start }
}

function formatElapsed(fromIso: string | null, now: number): string | null {
  if (!fromIso) return null
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// Re-renders once a second so the elapsed clock ticks between polls.
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

// The bar itself. `variant="card"` is the full block for a page body;
// `variant="inline"` is a slim strip for a banner or header.
export function SyncProgressBar({
  status,
  variant = 'card',
}: {
  status: SyncStatus
  variant?: 'card' | 'inline'
}) {
  const running = status.status === 'running'
  const now = useNow(running)
  const pct = running ? status.progress : status.status === 'ok' ? 100 : status.progress
  const elapsed = formatElapsed(status.startedAt, running ? now : new Date(status.finishedAt ?? now).getTime())
  const phase = status.phase ?? 'Starting'

  const track = (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label="Sync progress"
      style={{
        height: variant === 'card' ? '6px' : '4px',
        borderRadius: '999px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--hairline)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: '100%',
          borderRadius: '999px',
          background: status.status === 'error' ? 'var(--accent-red)' : 'var(--accent-purple)',
          transition: 'width 600ms ease',
        }}
      />
    </div>
  )

  if (variant === 'inline') {
    return (
      <div className="space-y-1.5" style={{ minWidth: 0 }}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate" style={{ fontSize: '12px', color: 'var(--ink-secondary)' }}>
            {phase}
          </span>
          <span className="shrink-0" style={{ fontSize: '12px', color: 'var(--ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
            {pct}%{elapsed ? ` · ${elapsed}` : ''}
          </span>
        </div>
        {track}
      </div>
    )
  }

  return (
    <div className="wl-card" style={{ padding: '28px 28px 24px' }}>
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1.5" style={{ minWidth: 0 }}>
          <div className="wl-eyebrow">{running ? 'Syncing products' : status.status === 'ok' ? 'Sync complete' : 'Sync failed'}</div>
          <p className="truncate" style={{ fontSize: '15px', color: 'var(--ink-secondary)', lineHeight: 1.6 }}>
            {phase}
          </p>
        </div>
        <div
          className="shrink-0"
          style={{
            fontSize: '30px',
            fontWeight: 500,
            letterSpacing: '-0.02em',
            lineHeight: 1.1,
            color: 'var(--ink)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {pct}%
        </div>
      </div>
      <div className="mt-4">{track}</div>
      <div className="mt-3 flex items-center justify-between gap-3" style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>
        <span>{running ? 'You can leave this page — the sync keeps running.' : ''}</span>
        {elapsed && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{elapsed}</span>}
      </div>
    </div>
  )
}
