'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { runFeedValidation } from './actions'
import { FeedSection } from '../dashboard/FeedSection'
import { FeedValidation } from './FeedValidation'
import type { ValidationIssue, ValidationResult } from '@/lib/feedValidator'
import { staleSyncDays } from '@/lib/syncSchedule'
import type { SyncStatus } from '@/lib/syncProgress'
import { SyncProgressBar, fetchSyncStatus } from '../components/SyncProgress'

type CacheInfo = {
  generated_at: string | null
  product_count: number | null
}

// Threshold below which the "Næste skridt" panel appears. Wizard-created
// feeds get 8 default mappings (the required Google fields) so they sit
// right at this line; anything less means the feed isn't usable yet.
const NEW_FEED_THRESHOLD = 8

export function FeedClient({
  feedId,
  feedName,
  initialCacheInfo,
  initialValidation,
  mappingCount,
  totalFields,
  lastSynced,
  optimizedCount,
}: {
  feedId: string
  feedName: string
  initialCacheInfo: CacheInfo | null
  initialValidation: ValidationResult | null
  mappingCount: number
  totalFields: number
  lastSynced: string | null
  optimizedCount: number
}) {
  // LAG 2 — included / excluded product counts come from the slow paginated
  // countFilteredProducts call. Fetched client-side so the overview renders
  // without waiting on it; null = still loading.
  const [includedCount, setIncludedCount] = useState<number | null>(null)
  const [excludedCount, setExcludedCount] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/feeds/${encodeURIComponent(feedId)}/counts`)
      .then((r) => r.json())
      .then((data: { included?: number; excluded?: number }) => {
        if (cancelled) return
        setIncludedCount(data.included ?? 0)
        setExcludedCount(data.excluded ?? 0)
      })
      .catch(() => {
        if (cancelled) return
        setIncludedCount(0)
        setExcludedCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [feedId])
  const searchParams = useSearchParams()
  const showSyncBanner = searchParams.get('syncing') === '1'

  // Lifted state — shared by FeedSection, NextSteps "Generer feed", the
  // status overview, the statistics grid, the validation mini and the full
  // validation panel. This keeps every section in sync after an action.
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(initialCacheInfo)
  const [validation, setValidation] = useState<ValidationResult | null>(initialValidation)

  const [isGenerating, setIsGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const [isValidating, startValidating] = useTransition()
  const [validationError, setValidationError] = useState<string | null>(null)

  async function regenerate() {
    setIsGenerating(true)
    setGenerateError(null)
    try {
      const res = await fetch(`/api/feed/generate/${feedId}`, { method: 'POST' })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const info = (await res.json()) as {
        generated_at: string
        product_count: number
        validation_status: ValidationResult['status'] | null
        validation_errors: ValidationIssue[] | null
      }
      setCacheInfo({ generated_at: info.generated_at, product_count: info.product_count })
      if (info.validation_status && info.validation_errors) {
        setValidation({
          status: info.validation_status,
          issues: info.validation_errors,
          productsChecked: 0,
        })
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setIsGenerating(false)
    }
  }

  function runValidation() {
    startValidating(async () => {
      setValidationError(null)
      const res = await runFeedValidation(feedId)
      if ('error' in res) {
        setValidationError(res.error)
      } else {
        setValidation(res)
      }
    })
  }

  const status = deriveStatus(!!cacheInfo?.generated_at, validation?.status ?? null)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <main className="max-w-4xl mx-auto px-6 py-10 space-y-10">
        {showSyncBanner && <SyncStatusBanner feedId={feedId} />}

        {/* Hero — a big, confident feed title with status as a small eyebrow
            pill. The title carries the page; colour stays a tiny accent. */}
        <header className="space-y-3.5">
          <StatusPill status={status} />
          <h1
            style={{
              fontSize: '34px',
              fontWeight: 500,
              letterSpacing: '-0.02em',
              lineHeight: 1.1,
              color: 'var(--ink)',
            }}
          >
            {feedName}
          </h1>
          <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink-secondary)', maxWidth: '48ch' }}>
            Set up mapping, filters and AI titles, then generate and validate your Google Shopping feed.
          </p>
        </header>

        {mappingCount < NEW_FEED_THRESHOLD && (
          <NextSteps feedId={feedId} onGenerate={regenerate} isGenerating={isGenerating} />
        )}

        {/* Workspace — calm neutral cards; colour only in the small icon-fields. */}
        <section className="space-y-4">
          <div className="wl-eyebrow">Workspace</div>
          <FunctionCards
            feedId={feedId}
            mappingCount={mappingCount}
            totalFields={totalFields}
            includedCount={includedCount}
            feedItemCount={cacheInfo?.product_count ?? null}
            optimizedCount={optimizedCount}
          />
        </section>

        <StatisticsSection
          feedItemCount={cacheInfo?.product_count ?? null}
          includedCount={includedCount}
          excludedCount={excludedCount}
          lastSynced={lastSynced}
          lastGenerated={cacheInfo?.generated_at ?? null}
        />

        <FeedSection
          feedId={feedId}
          cacheInfo={cacheInfo}
          onRegenerate={regenerate}
          isRegenerating={isGenerating}
          error={generateError}
        />

        <FeedValidation
          result={validation}
          isRunning={isValidating}
          onRun={runValidation}
          runError={validationError}
        />
      </main>
    </div>
  )
}

// ── Function cards ──────────────────────────────────────────────────────────

// The feed's key functions as calm neutral cards: a SMALL colour icon-field
// (the only colour), a title and a key number. Colour lives in the ~40px field,
// not the whole card. Pure navigation — Links to existing pages, no logic.
function FunctionCards({
  feedId,
  mappingCount,
  totalFields,
  includedCount,
  feedItemCount,
  optimizedCount,
}: {
  feedId: string
  mappingCount: number
  totalFields: number
  includedCount: number | null
  feedItemCount: number | null
  optimizedCount: number
}) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <FeatureCard
        href={`/feed/${feedId}/mapping`}
        tint="var(--field-purple)"
        icon={<IconSliders />}
        label="Mapping"
        value={`${mappingCount}/${totalFields}`}
        sub="fields mapped"
      />
      <FeatureCard
        href={`/feed/${feedId}/optimize`}
        tint="var(--field-amber)"
        icon={<IconSparkles />}
        label="AI Titles"
        value={String(optimizedCount)}
        sub="optimized"
      />
      <FeatureCard
        href={`/feed/${feedId}/filters`}
        tint="var(--field-pink)"
        icon={<IconFilter />}
        label="Filters"
        value={includedCount != null ? String(includedCount) : undefined}
        sub={includedCount != null ? 'included' : 'Configure rules'}
      />
      <FeatureCard
        href={`/feed/${feedId}/preview`}
        tint="var(--field-mint)"
        icon={<IconEye />}
        label="Preview"
        value={feedItemCount != null ? String(feedItemCount) : undefined}
        sub="items in feed"
      />
    </div>
  )
}

// Card + icon-field styling is inlined (not only the .wl-feature/.wl-iconfield
// classes) so each card renders as a clearly-bounded, tinted tile regardless of
// global-CSS compile state; the class only layers on the hover lift.
function FeatureCard({
  href,
  tint,
  icon,
  label,
  value,
  sub,
}: {
  href: string
  tint: string
  icon: React.ReactNode
  label: string
  value?: string
  sub: string
}) {
  return (
    <Link
      href={href}
      className="wl-feature"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '13px',
        padding: '16px',
        background: '#ffffff',
        border: '1px solid var(--hairline)',
        borderRadius: '14px',
        textDecoration: 'none',
      }}
    >
      <div className="flex items-start justify-between">
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '40px',
            height: '40px',
            borderRadius: '10px',
            border: '1px solid var(--ink)',
            background: tint,
            color: 'var(--ink)',
          }}
        >
          {icon}
        </span>
        <IconArrowUpRight />
      </div>
      <div>
        <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--ink)' }}>{label}</div>
        {value ? (
          <div
            className="mt-1.5"
            style={{ fontSize: '24px', fontWeight: 500, letterSpacing: '-0.01em', lineHeight: 1, color: 'var(--ink)' }}
          >
            {value}
          </div>
        ) : null}
        <div className="mt-1" style={{ fontSize: '12px', color: 'var(--ink-muted)' }}>{sub}</div>
      </div>
    </Link>
  )
}

// ── Tabler-style icons (product-neutral) ────────────────────────────────────

const tablerProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

function IconSliders() {
  return (
    <svg {...tablerProps}>
      <path d="M4 6h11M18 6h2M4 12h2M9 12h11M4 18h13M20 18h0M17 18h0" />
      <circle cx="16" cy="6" r="2" /><circle cx="7" cy="12" r="2" /><circle cx="15" cy="18" r="2" />
    </svg>
  )
}
function IconSparkles() {
  return (
    <svg {...tablerProps}>
      <path d="M12 3l1.9 4.8L18.7 9.7 13.9 11.6 12 16.4 10.1 11.6 5.3 9.7 10.1 7.8z" />
      <path d="M19 14l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" />
    </svg>
  )
}
function IconFilter() {
  return (
    <svg {...tablerProps}>
      <path d="M4 4h16l-6 8v6l-4 2v-8z" />
    </svg>
  )
}
function IconEye() {
  return (
    <svg {...tablerProps}>
      <circle cx="12" cy="12" r="2.5" />
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    </svg>
  )
}
function IconArrowUpRight() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
      <path d="M7 17L17 7M8 7h9v9" />
    </svg>
  )
}

// ── Status overview ────────────────────────────────────────────────────────

type StatusKind = 'ready' | 'warnings' | 'errors' | 'not-generated'

function deriveStatus(
  generated: boolean,
  validationStatus: ValidationResult['status'] | null
): StatusKind {
  if (!generated) return 'not-generated'
  if (validationStatus === 'errors') return 'errors'
  if (validationStatus === 'warnings') return 'warnings'
  return 'ready'
}

// Small status pill for the hero eyebrow — a coloured dot does the colour work
// against an otherwise neutral pill, in line with "colour as small accents".
function StatusPill({ status }: { status: StatusKind }) {
  const meta = STATUS_META[status]
  return (
    <span className="wl-pill">
      <span className="wl-dot" style={{ background: meta.dot }} />
      {meta.label}
    </span>
  )
}

const STATUS_META: Record<StatusKind, { label: string; dot: string }> = {
  ready: { label: 'Feed ready', dot: 'var(--accent-green)' },
  warnings: { label: 'Warnings', dot: 'var(--accent-amber)' },
  errors: { label: 'Errors', dot: 'var(--accent-red)' },
  'not-generated': { label: 'Not generated yet', dot: 'var(--ink-muted)' },
}

// ── Statistics ─────────────────────────────────────────────────────────────

function StatisticsSection({
  feedItemCount,
  includedCount,
  excludedCount,
  lastSynced,
  lastGenerated,
}: {
  feedItemCount: number | null
  includedCount: number | null
  excludedCount: number | null
  lastSynced: string | null
  lastGenerated: string | null
}) {
  const staleDays = staleSyncDays(lastSynced)
  return (
    <div className="wl-card" style={{ overflow: 'hidden' }}>
      {/* Three confident numbers, separated by hairlines — no boxed tiles. */}
      <div className="grid grid-cols-3">
        <StatCell first label="Items in feed" value={feedItemCount != null ? String(feedItemCount) : '—'} />
        <StatCell label="Included" value={includedCount == null ? '…' : String(includedCount)} />
        <StatCell
          label="Excluded"
          value={excludedCount == null ? '…' : excludedCount === 0 ? 'None' : String(excludedCount)}
        />
      </div>
      <div
        className="flex flex-wrap gap-x-8 gap-y-1"
        style={{ padding: '13px 20px', borderTop: '1px solid var(--hairline)' }}
      >
        <Meta label="Last synced" value={formatDateTime(lastSynced)} />
        <Meta label="Last generated" value={formatDateTime(lastGenerated)} />
      </div>
      {staleDays != null && (
        <div
          style={{
            padding: '11px 20px',
            borderTop: '1px solid var(--hairline)',
            background: 'var(--color-badge-warning-bg)',
            color: 'var(--color-badge-warning-text)',
            fontSize: '12px',
            lineHeight: 1.5,
          }}
        >
          Product data is {staleDays} days old — the sync has been failing. Check the error under
          Settings → Automatic sync; a rejected Shopify token needs a new one via the project page.
        </div>
      )}
    </div>
  )
}

function StatCell({ label, value, first }: { label: string; value: string; first?: boolean }) {
  return (
    <div style={{ padding: '18px 20px', borderLeft: first ? 'none' : '1px solid var(--hairline)' }}>
      <p className="wl-eyebrow">{label}</p>
      <p
        className="mt-2"
        style={{ fontSize: '28px', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.05, color: 'var(--ink)' }}
      >
        {value}
      </p>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-2" style={{ fontSize: '12px' }}>
      <span className="wl-eyebrow">{label}</span>
      <span style={{ color: 'var(--ink-secondary)' }}>{value}</span>
    </span>
  )
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

// ── Next steps ─────────────────────────────────────────────────────────────

function NextSteps({
  feedId,
  onGenerate,
  isGenerating,
}: {
  feedId: string
  onGenerate: () => void
  isGenerating: boolean
}) {
  return (
    <div className="wl-card">
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
        <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--ink)' }}>Next steps</span>
      </div>
      <div className="p-4 space-y-3">
        <NextStepRow n={1}>
          <Link href={`/feed/${feedId}/mapping`} className="wl-btn-secondary">
            Set up mapping
          </Link>
        </NextStepRow>
        <NextStepRow n={2}>
          <Link href={`/feed/${feedId}/filters`} className="wl-btn-secondary">
            Configure filters
          </Link>
        </NextStepRow>
        <NextStepRow n={3}>
          <button
            type="button"
            onClick={onGenerate}
            disabled={isGenerating}
            className="wl-btn-primary"
          >
            {isGenerating ? 'Generating…' : 'Generate feed'}
          </button>
        </NextStepRow>
      </div>
    </div>
  )
}

function NextStepRow({ n, children }: { n: number; children: React.ReactNode }) {
  const labels = ['Set up mapping', 'Configure filters', 'Generate feed']
  return (
    <div className="flex items-center gap-3.5">
      <div
        className="shrink-0 inline-flex items-center justify-center ff-mono"
        style={{
          width: '26px',
          height: '26px',
          borderRadius: '999px',
          background: 'var(--ink)',
          color: 'var(--bg-base)',
          fontSize: '11px',
          fontWeight: 500,
        }}
      >
        {String(n).padStart(2, '0')}
      </div>
      <span className="flex-1" style={{ fontSize: '13.5px', color: 'var(--ink)' }}>
        {labels[n - 1]}
      </span>
      {children}
    </div>
  )
}

// ── Sync banner (existing — unchanged) ─────────────────────────────────────

// Follows the wizard's sync via the feed's sync status (lib/syncProgress.ts),
// then auto-regenerates the feed so feed_cache.xml_content reflects the new
// rows. Triggered by the wizard navigating with ?syncing=1. Existing feeds
// (no query param) never see this.
//
// It used to poll /api/products until total > 0 — which fired after the FIRST
// saved batch of a multi-minute sync, so the feed was generated from a partial
// catalogue. The sync status says when the sync is actually over.
//
// Phase machine:
//   syncing    → polling sync-status (progress bar) until ok / error
//   sync-done  → brief acknowledgement
//   generating → POST /api/feed/generate/[feedId] in flight
//   ready      → generation finished; ?syncing=1 is stripped after a moment
//   timeout    → the sync never started within SYNC_START_MAX_MS
//   error      → the sync or generation failed
type Phase = 'syncing' | 'sync-done' | 'generating' | 'ready' | 'timeout' | 'error'

// The wizard fires the sync request just before navigating here, so the claim
// usually lands within a second; this only catches a request that never ran.
const SYNC_START_MAX_MS = 30_000
const SYNC_POLL_INTERVAL_MS = 1_500
const SYNC_DONE_DISPLAY_MS = 1_200
const READY_DISPLAY_MS = 3_000

function SyncStatusBanner({ feedId }: { feedId: string }) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('syncing')
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null)
  const [syncedCount, setSyncedCount] = useState<number | null>(null)
  const [feedItemCount, setFeedItemCount] = useState<number | null>(null)

  useEffect(() => {
    if (phase !== 'syncing') return
    const startedAt = Date.now()
    let cancelled = false

    async function tick() {
      const s = await fetchSyncStatus(feedId)
      if (cancelled || !s) return
      setSyncStatus(s)
      if (s.status === 'error') {
        setPhase('error')
        return
      }
      if (s.status === 'ok') {
        // The count for the acknowledgement; the status row doesn't carry it.
        try {
          const res = await fetch(
            `/api/products?feedId=${encodeURIComponent(feedId)}&pageSize=1&page=1`,
            { cache: 'no-store' }
          )
          if (res.ok) setSyncedCount(((await res.json()) as { total?: number }).total ?? null)
        } catch {
          // Count is cosmetic — proceed without it.
        }
        if (!cancelled) setPhase('sync-done')
        return
      }
      // 'idle' = the claim hasn't landed yet. 'running' has no time limit
      // here — the progress bar shows it moving, and a dead run turns into
      // 'error' server-side once stale.
      if (s.status === 'idle' && Date.now() - startedAt > SYNC_START_MAX_MS) setPhase('timeout')
    }

    void tick()
    const id = setInterval(tick, SYNC_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [feedId, phase])

  useEffect(() => {
    if (phase !== 'sync-done') return
    const t = setTimeout(() => setPhase('generating'), SYNC_DONE_DISPLAY_MS)
    return () => clearTimeout(t)
  }, [phase])

  useEffect(() => {
    if (phase !== 'generating') return
    let cancelled = false

    fetch(`/api/feed/generate/${encodeURIComponent(feedId)}`, { method: 'POST' })
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setPhase('error')
          return
        }
        const data = (await res.json()) as { product_count?: number }
        setFeedItemCount(data.product_count ?? syncedCount ?? null)
        setPhase('ready')
      })
      .catch(() => {
        if (!cancelled) setPhase('error')
      })

    return () => {
      cancelled = true
    }
  }, [phase, feedId, syncedCount])

  useEffect(() => {
    if (phase === 'syncing' || phase === 'sync-done' || phase === 'generating') return
    if (phase === 'ready') {
      const t = setTimeout(() => router.replace(`/feed/${feedId}`), READY_DISPLAY_MS)
      return () => clearTimeout(t)
    }
    router.replace(`/feed/${feedId}`)
  }, [phase, feedId, router])

  if (phase === 'syncing') {
    return (
      <PendingBanner
        title="Syncing products…"
        subtitle="You can navigate away — the sync continues in the background."
      >
        {syncStatus?.status === 'running' && (
          <div className="mt-2.5">
            <SyncProgressBar status={syncStatus} variant="inline" />
          </div>
        )}
      </PendingBanner>
    )
  }

  if (phase === 'sync-done') {
    return (
      <SuccessBanner
        text={`Sync complete — ${syncedCount} ${syncedCount === 1 ? 'product' : 'products'} fetched`}
      />
    )
  }

  if (phase === 'generating') {
    return (
      <PendingBanner
        title="Generating feed…"
        subtitle="Building XML from the synced products."
      />
    )
  }

  if (phase === 'ready') {
    const count = feedItemCount ?? syncedCount ?? 0
    return (
      <SuccessBanner text={`Feed ready — ${count} ${count === 1 ? 'product' : 'products'}`} />
    )
  }

  return null
}

function PendingBanner({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children?: React.ReactNode
}) {
  return (
    <div
      className="ff-panel p-3 flex items-center gap-2.5"
      style={{
        background: 'var(--color-badge-accent-bg)',
        borderColor: 'var(--color-accent)',
      }}
    >
      <svg
        className="w-4 h-4 animate-spin shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        style={{ color: 'var(--color-accent)' }}
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
          {title}
        </p>
        {subtitle && (
          <p
            className="mt-0.5"
            style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}
          >
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </div>
  )
}

function SuccessBanner({ text }: { text: string }) {
  return (
    <div
      className="ff-panel p-3"
      style={{
        background: 'var(--color-badge-success-bg)',
        borderColor: 'var(--color-badge-success-text)',
      }}
    >
      <p style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-badge-success-text)' }}>
        {text}
      </p>
    </div>
  )
}
