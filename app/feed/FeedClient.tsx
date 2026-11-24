'use client'

import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { runFeedValidation } from './actions'
import type { ValidationIssue, ValidationResult } from '@/lib/feedValidator'
import { staleSyncDays } from '@/lib/syncSchedule'
import type { SyncStatus } from '@/lib/syncProgress'
import { channelOf } from '@/lib/channels'
import { countryName, formatNumber, formatWhen } from '@/lib/formatDa'
import { Icon, type IconName } from '../components/shell/icons'
import { SyncProgressBar, fetchSyncStatus } from '../components/SyncProgress'
import './overview.css'

// Feed › Overview (reference: references/feed_overview.jpg). The feed's state
// in one card, the link channels fetch it from, and a list of what to fix —
// each row links to where the fix is made.

type CacheInfo = {
  generated_at: string | null
  product_count: number | null
}

// Below this many mapped fields the feed is not usable yet. Wizard-created
// feeds get 8 default mappings (the required Google fields).
const NEW_FEED_THRESHOLD = 8

export function FeedClient({
  feedId,
  channel,
  country,
  initialCacheInfo,
  initialValidation,
  mappingCount,
  totalFields,
  missingRequired,
  lastSynced,
}: {
  feedId: string
  channel: string
  country: string | null
  initialCacheInfo: CacheInfo | null
  initialValidation: ValidationResult | null
  mappingCount: number
  totalFields: number
  missingRequired: string[]
  lastSynced: string | null
}) {
  // Included / excluded come from the slow paginated count; null = loading.
  const [counts, setCounts] = useState<{ included: number; excluded: number } | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/feeds/${encodeURIComponent(feedId)}/counts`)
      .then((r) => r.json())
      .then((d: { included?: number; excluded?: number }) => {
        if (!cancelled) setCounts({ included: d.included ?? 0, excluded: d.excluded ?? 0 })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [feedId])

  const showSyncBanner = useSearchParams().get('syncing') === '1'

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
        setValidation({ status: info.validation_status, issues: info.validation_errors, productsChecked: 0 })
      }
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'The feed could not be generated')
    } finally {
      setIsGenerating(false)
    }
  }

  function runValidation() {
    startValidating(async () => {
      setValidationError(null)
      const res = await runFeedValidation(feedId)
      if ('error' in res) setValidationError(res.error)
      else setValidation(res)
    })
  }

  const generated = !!cacheInfo?.generated_at
  const issues = validation?.issues ?? []
  const errorCount = issues.filter((i) => i.type === 'error').length
  const warningCount = issues.filter((i) => i.type === 'warning').length
  const staleDays = staleSyncDays(lastSynced)
  const where = [channelOf(channel).label, countryName(country)].filter(Boolean).join(' · ')

  return (
    <div className="ov">
      {showSyncBanner && <SyncStatusBanner feedId={feedId} />}

      <div className="ov-head">
        <div>
          <h1>Overview</h1>
          <p className="ov-lede">
            {where ? `${where}. ` : ''}The feed’s status, what needs fixing, and the link you connect with.
          </p>
        </div>
        <div className="ov-actions">
          <button type="button" className="wl-btn-secondary" onClick={runValidation} disabled={isValidating || !generated}>
            <Icon name="check" size={14} />
            {isValidating ? 'Validating…' : 'Run validation'}
          </button>
          <button type="button" className="wl-btn-primary" onClick={() => void regenerate()} disabled={isGenerating}>
            {isGenerating ? 'Generating…' : 'Generate feed'}
          </button>
        </div>
      </div>

      {generateError && <p className="note warn">The feed could not be generated: {generateError}</p>}
      {validationError && <p className="note warn">Validation failed: {validationError}</p>}
      {staleDays != null && (
        <p className="note warn">
          The products are {staleDays} days old because the sync is failing. See the error under{' '}
          <Link href={`/feed/${feedId}/settings`}>Settings</Link>. A rejected Shopify key is replaced on
          the shop’s Feeds page.
        </p>
      )}

      <section className="card ov-status">
        <div className="ov-card-h">
          <div>
            <h3>Feed status</h3>
            <small>
              {generated ? `Generated ${formatWhen(cacheInfo?.generated_at)}` : 'Not generated yet'}
              {lastSynced ? ` · products synced ${formatWhen(lastSynced)}` : ''}
            </small>
          </div>
          {!generated ? (
            <span className="st st-off">Not generated</span>
          ) : errorCount > 0 ? (
            <span className="neg">The feed has errors</span>
          ) : (
            <span className="st">The feed is running</span>
          )}
        </div>

        <div className="ov-stats">
          <Stat label="Products in feed">
            <strong className="num">{generated && cacheInfo?.product_count != null ? formatNumber(cacheInfo.product_count) : '—'}</strong>
            <small>
              {counts ? `of ${formatNumber(counts.included + counts.excluded)} in the shop` : generated ? '' : 'Generate the feed first'}
            </small>
          </Stat>
          <Stat label="Fields mapped">
            <strong className="num">
              {mappingCount}
              <sub> / {totalFields}</sub>
            </strong>
            {missingRequired.length > 0 ? (
              <small className="neg">
                {missingRequired.length} required {missingRequired.length === 1 ? 'field' : 'fields'} missing
              </small>
            ) : (
              <small>All required fields are mapped</small>
            )}
          </Stat>
          <Stat label="Excluded">
            <strong className="num">{counts ? formatNumber(counts.excluded) : '…'}</strong>
            <small>by the rules under Include / exclude</small>
          </Stat>
          <Stat label="Warnings">
            <strong className={`num${warningCount > 0 ? ' neg-num' : ''}`}>{validation ? formatNumber(warningCount) : '—'}</strong>
            {errorCount > 0 ? (
              <small className="neg">
                {formatNumber(errorCount)} {errorCount === 1 ? 'error' : 'errors'}
              </small>
            ) : (
              <small>{validation ? '0 errors' : 'Not validated yet'}</small>
            )}
          </Stat>
        </div>

        <div className="ov-link">
          <p className="ov-label">Feed link · use it in Merchant Center or wherever the feed is fetched from</p>
          <FeedUrlBox feedId={feedId} />
        </div>
      </section>

      <IssuesCard
        feedId={feedId}
        generated={generated}
        mappingCount={mappingCount}
        missingRequired={missingRequired}
        validation={validation}
        errorCount={errorCount}
        warningCount={warningCount}
        isGenerating={isGenerating}
        onGenerate={() => void regenerate()}
      />
    </div>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ov-stat">
      <span className="ov-stat-l">{label}</span>
      {children}
    </div>
  )
}

function FeedUrlBox({ feedId }: { feedId: string }) {
  const [copied, setCopied] = useState(false)
  // window is only available after mount; the path alone is shown until then.
  const [origin, setOrigin] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setOrigin(window.location.origin), 0)
    return () => clearTimeout(t)
  }, [])
  const url = `${origin}/api/feed/generate/${feedId}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/api/feed/generate/${feedId}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked: the URL is visible and can be copied by hand.
    }
  }

  return (
    <div className="ov-url">
      <Icon name="feeds" size={16} />
      <span className="ov-url-text">{url}</span>
      <button type="button" className="ff-btn-primary" onClick={() => void copy()}>
        {copied ? '✓ Copied' : 'Copy link'}
      </button>
    </div>
  )
}

// ── Fejl og advarsler ───────────────────────────────────────────────────────

type IssueItem = {
  key: string
  icon: IconName
  title: string
  detail: string
  action: { label: string; href: string } | { label: string; onClick: () => void; busy?: boolean }
}

function IssuesCard({
  feedId,
  generated,
  mappingCount,
  missingRequired,
  validation,
  errorCount,
  warningCount,
  isGenerating,
  onGenerate,
}: {
  feedId: string
  generated: boolean
  mappingCount: number
  missingRequired: string[]
  validation: ValidationResult | null
  errorCount: number
  warningCount: number
  isGenerating: boolean
  onGenerate: () => void
}) {
  const mappingHref = `/feed/${feedId}/mapping`
  const items: IssueItem[] = []

  if (!generated) {
    items.push({
      key: 'not-generated',
      icon: 'feeds',
      title: 'The feed has not been generated yet',
      detail: 'Channels can only fetch the feed once it has been generated.',
      action: { label: isGenerating ? 'Generating…' : 'Generate feed', onClick: onGenerate, busy: isGenerating },
    })
  }
  if (mappingCount < NEW_FEED_THRESHOLD && missingRequired.length === 0) {
    items.push({
      key: 'few-mappings',
      icon: 'mapping',
      title: `Only ${mappingCount} fields are mapped`,
      detail: 'Map more fields so the channel gets the information it uses to show the products.',
      action: { label: 'Open mapping', href: mappingHref },
    })
  }
  // Validator issues. Unmapped required fields come from the validator too
  // when a validation exists; otherwise list them from the mapping itself.
  const validatorFields = new Set((validation?.issues ?? []).map((i) => i.field))
  for (const f of missingRequired) {
    if (validatorFields.has(f)) continue
    items.push({
      key: `missing-${f}`,
      icon: 'mapping',
      title: `${f} is not mapped`,
      detail: 'The field is required. Without it the channel rejects the products.',
      action: { label: 'Open mapping', href: mappingHref },
    })
  }
  for (const [n, issue] of (validation?.issues ?? []).entries()) {
    const affected = issue.affectedCount > 0 ? `${formatNumber(issue.affectedCount)} ${issue.affectedCount === 1 ? 'product' : 'products'}` : null
    const example = issue.exampleValue !== undefined ? `e.g. “${issue.exampleValue || 'empty'}”` : null
    items.push({
      key: `v-${n}`,
      icon: issue.type === 'error' ? 'drop' : 'tag',
      title: `${issue.field}: ${issue.message}`,
      detail: [issue.type === 'error' ? 'Error' : 'Warning', affected, example].filter(Boolean).join(' · '),
      action: { label: 'Open mapping', href: mappingHref },
    })
  }

  const total = errorCount + warningCount
  const summary =
    errorCount > 0
      ? `${formatNumber(errorCount)} ${errorCount === 1 ? 'error' : 'errors'}${warningCount ? ` · ${formatNumber(warningCount)} ${warningCount === 1 ? 'warning' : 'warnings'}` : ''}`
      : warningCount > 0
        ? `${formatNumber(warningCount)} ${warningCount === 1 ? 'warning' : 'warnings'}`
        : null

  return (
    <section className="card ov-issues">
      <div className="ov-card-h">
        <div>
          <h3>Errors and warnings</h3>
          <small>{items.length ? 'Click to fix' : 'Anything that needs fixing in the feed shows up here'}</small>
        </div>
        {summary ? <span className="neg">{summary}</span> : total === 0 && validation ? <span className="st">No errors</span> : null}
      </div>

      {items.length > 0 && (
        <ul className="ov-list">
          {items.map((it) => (
            <li key={it.key}>
              <IssueRow item={it} />
            </li>
          ))}
        </ul>
      )}

      <p className="ov-checked">
        {!validation
          ? generated
            ? 'The feed has not been validated yet. Run validation to check it.'
            : 'Validation runs when the feed is generated.'
          : validation.productsChecked > 0
            ? `Checked on ${formatNumber(validation.productsChecked)} products.`
            : 'Showing the last saved validation. Run validation again for a fresh result.'}
      </p>
    </section>
  )
}

function IssueRow({ item }: { item: IssueItem }) {
  const body = (
    <>
      <span className="ov-ic">
        <Icon name={item.icon} size={14} />
      </span>
      <span className="ov-issue-text">
        <b>{item.title}</b>
        <small>{item.detail}</small>
      </span>
      <span className="link">{item.action.label}</span>
    </>
  )
  if ('href' in item.action) {
    return (
      <Link href={item.action.href} className="ov-issue">
        {body}
      </Link>
    )
  }
  return (
    <button type="button" className="ov-issue" onClick={item.action.onClick} disabled={item.action.busy}>
      {body}
    </button>
  )
}

// ── Sync banner ────────────────────────────────────────────────────────────

// Follows the wizard's first sync via the feed's sync status (lib/syncProgress.ts),
// then generates the feed so feed_cache reflects the synced rows. Shown when the
// wizard navigates here with ?syncing=1.
//
//   syncing    → polling sync-status (progress bar) until ok / error
//   sync-done  → brief acknowledgement
//   generating → POST /api/feed/generate/[feedId] in flight
//   ready      → generation finished; ?syncing=1 is stripped after a moment
//   timeout    → the sync never started within SYNC_START_MAX_MS
//   error      → the sync or generation failed
type Phase = 'syncing' | 'sync-done' | 'generating' | 'ready' | 'timeout' | 'error'

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
        try {
          const res = await fetch(`/api/products?feedId=${encodeURIComponent(feedId)}&pageSize=1&page=1`, {
            cache: 'no-store',
          })
          if (res.ok) setSyncedCount(((await res.json()) as { total?: number }).total ?? null)
        } catch {
          // The count is cosmetic.
        }
        if (!cancelled) setPhase('sync-done')
        return
      }
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
      // A full reload so the server-rendered numbers pick up the new feed.
      const t = setTimeout(() => {
        router.replace(`/feed/${feedId}`)
        router.refresh()
      }, READY_DISPLAY_MS)
      return () => clearTimeout(t)
    }
    router.replace(`/feed/${feedId}`)
  }, [phase, feedId, router])

  if (phase === 'syncing') {
    return (
      <div className="note ov-banner" role="status">
        <b>Fetching products from the source…</b> You can carry on. The sync runs in the background.
        {syncStatus?.status === 'running' && (
          <div className="ov-banner-bar">
            <SyncProgressBar status={syncStatus} variant="inline" />
          </div>
        )}
      </div>
    )
  }
  if (phase === 'sync-done') {
    return (
      <p className="note ov-banner ov-banner-ok" role="status">
        Products fetched{syncedCount != null ? `: ${formatNumber(syncedCount)}` : ''}.
      </p>
    )
  }
  if (phase === 'generating') {
    return (
      <p className="note ov-banner" role="status">
        <b>Generating the feed…</b> Building XML from the fetched products.
      </p>
    )
  }
  if (phase === 'ready') {
    const n = feedItemCount ?? syncedCount ?? 0
    return (
      <p className="note ov-banner ov-banner-ok" role="status">
        The feed is ready with {formatNumber(n)} {n === 1 ? 'product' : 'products'}.
      </p>
    )
  }
  return null
}
