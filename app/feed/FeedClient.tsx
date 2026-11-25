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
import { takeFeedEdited } from '@/lib/recentEdit'

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
      setGenerateError(err instanceof Error ? err.message : 'Feedet kunne ikke genereres')
    } finally {
      setIsGenerating(false)
    }
  }

  // Arriving after a save on Mapping / Include / exclude / Settings: the stored
  // result may be from before the change, so check again right away.
  const [recheckAfterEdit, setRecheckAfterEdit] = useState(false)
  useEffect(() => {
    if (!initialCacheInfo?.generated_at || !takeFeedEdited(feedId)) return
    setRecheckAfterEdit(true) // eslint-disable-line react-hooks/set-state-in-effect -- one-time check on arrival
    runValidation()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per arrival
  }, [feedId])

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
            {where ? `${where}. ` : ''}Status på feedet, det der skal rettes, og linket du kobler op med.
          </p>
        </div>
        <div className="ov-actions">
          <button type="button" className="wl-btn-secondary" onClick={runValidation} disabled={isValidating || !generated}>
            <Icon name="check" size={14} />
            {isValidating ? 'Validerer…' : 'Kør validering'}
          </button>
          <button type="button" className="wl-btn-primary" onClick={() => void regenerate()} disabled={isGenerating}>
            {isGenerating ? 'Genererer…' : 'Generér feed'}
          </button>
        </div>
      </div>

      {generateError && <p className="note warn">Feedet kunne ikke genereres: {generateError}</p>}
      {validationError && <p className="note warn">Valideringen fejlede: {validationError}</p>}
      {staleDays != null && (
        <p className="note warn">
          Varerne er {staleDays} dage gamle, fordi synkroniseringen fejler. Se fejlen under{' '}
          <Link href={`/feed/${feedId}/settings`}>Settings</Link>. En afvist Shopify-nøgle skiftes på
          shoppens Feeds-side.
        </p>
      )}

      <section className="card ov-status">
        <div className="ov-card-h">
          <div>
            <h3>Feed status</h3>
            <small>
              {generated ? `Genereret ${formatWhen(cacheInfo?.generated_at)}` : 'Ikke genereret endnu'}
              {lastSynced ? ` · varer synket ${formatWhen(lastSynced)}` : ''}
            </small>
          </div>
          {!generated ? (
            <span className="st st-off">Ikke genereret</span>
          ) : errorCount > 0 ? (
            <span className="neg">Feedet har fejl</span>
          ) : (
            <span className="st">Feedet kører</span>
          )}
        </div>

        <div className="ov-stats">
          <Stat label="Varer i feed">
            <strong className="num">{generated && cacheInfo?.product_count != null ? formatNumber(cacheInfo.product_count) : '—'}</strong>
            <small>
              {counts ? `af ${formatNumber(counts.included + counts.excluded)} i shoppen` : generated ? '' : 'Generér feedet først'}
            </small>
          </Stat>
          <Stat label="Felter mappet">
            <strong className="num">
              {mappingCount}
              <sub> / {totalFields}</sub>
            </strong>
            {missingRequired.length > 0 ? (
              <small className="neg">
                {missingRequired.length} påkrævede {missingRequired.length === 1 ? 'felt' : 'felter'} mangler
              </small>
            ) : (
              <small>Alle påkrævede felter er mappet</small>
            )}
          </Stat>
          <Stat label="Ekskluderet">
            <strong className="num">{counts ? formatNumber(counts.excluded) : '…'}</strong>
            <small>af reglerne under Inkludér / ekskludér</small>
          </Stat>
          <Stat label="Advarsler">
            <strong className={`num${warningCount > 0 ? ' neg-num' : ''}`}>{validation ? formatNumber(warningCount) : '—'}</strong>
            {errorCount > 0 ? (
              <small className="neg">
                {formatNumber(errorCount)} fejl
              </small>
            ) : (
              <small>{validation ? '0 fejl' : 'Ikke valideret endnu'}</small>
            )}
          </Stat>
        </div>

        <div className="ov-link">
          <p className="ov-label">Link til feedet · brug det i Merchant Center eller der, hvor feedet skal hentes</p>
          <FeedUrlBox feedId={feedId} />
        </div>
      </section>

      <IssuesCard
        feedId={feedId}
        generated={generated}
        mappingCount={mappingCount}
        missingRequired={missingRequired}
        validation={validation}
        rechecking={isValidating && recheckAfterEdit}
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
        {copied ? '✓ Kopieret' : 'Kopiér link'}
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
  rechecking,
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
  rechecking: boolean
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
      title: 'Feedet er ikke genereret endnu',
      detail: 'Kanalerne kan først hente feedet, når det er genereret.',
      action: { label: isGenerating ? 'Genererer…' : 'Generér feed', onClick: onGenerate, busy: isGenerating },
    })
  }
  if (mappingCount < NEW_FEED_THRESHOLD && missingRequired.length === 0) {
    items.push({
      key: 'few-mappings',
      icon: 'mapping',
      title: `Kun ${mappingCount} felter er mappet`,
      detail: 'Map flere felter, så kanalen får de oplysninger, den bruger til at vise varerne.',
      action: { label: 'Åbn mapping', href: mappingHref },
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
      title: `${f} er ikke mappet`,
      detail: 'Feltet er påkrævet. Uden det afviser kanalen varerne.',
      action: { label: 'Åbn mapping', href: mappingHref },
    })
  }
  for (const [n, issue] of (validation?.issues ?? []).entries()) {
    const affected = issue.affectedCount > 0 ? `${formatNumber(issue.affectedCount)} varer` : null
    const example = issue.exampleValue !== undefined ? `fx «${issue.exampleValue || 'tom'}»` : null
    items.push({
      key: `v-${n}`,
      icon: issue.type === 'error' ? 'drop' : 'tag',
      title: `${issue.field}: ${issue.message}`,
      detail: [issue.type === 'error' ? 'Fejl' : 'Advarsel', affected, example].filter(Boolean).join(' · '),
      action: { label: 'Åbn mapping', href: mappingHref },
    })
  }

  const total = errorCount + warningCount
  const summary =
    errorCount > 0
      ? `${formatNumber(errorCount)} fejl${warningCount ? ` · ${formatNumber(warningCount)} advarsler` : ''}`
      : warningCount > 0
        ? `${formatNumber(warningCount)} ${warningCount === 1 ? 'advarsel' : 'advarsler'}`
        : null

  return (
    <section className="card ov-issues">
      <div className="ov-card-h">
        <div>
          <h3>Fejl og advarsler</h3>
          <small>{items.length ? 'Klik for at rette' : 'Her står det, der skal rettes i feedet'}</small>
        </div>
        {summary ? <span className="neg">{summary}</span> : total === 0 && validation ? <span className="st">Ingen fejl</span> : null}
      </div>
      {rechecking && <p className="ov-recheck">Tjekker feedet igen efter din ændring…</p>}

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
            ? 'Feedet er ikke valideret endnu. Kør validering for at tjekke det.'
            : 'Valideringen kører, når feedet genereres.'
          : validation.productsChecked > 0
            ? `Tjekket på ${formatNumber(validation.productsChecked)} varer.`
            : 'Viser senest gemte validering. Kør validering igen for et friskt resultat.'}
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
        <b>Henter varer fra kilden…</b> Du kan godt gå videre. Synkroniseringen kører i baggrunden.
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
        Varerne er hentet{syncedCount != null ? `: ${formatNumber(syncedCount)}` : ''}.
      </p>
    )
  }
  if (phase === 'generating') {
    return (
      <p className="note ov-banner" role="status">
        <b>Genererer feedet…</b> Bygger XML ud fra de hentede varer.
      </p>
    )
  }
  if (phase === 'ready') {
    const n = feedItemCount ?? syncedCount ?? 0
    return (
      <p className="note ov-banner ov-banner-ok" role="status">
        Feedet er klar med {formatNumber(n)} {n === 1 ? 'vare' : 'varer'}.
      </p>
    )
  }
  return null
}
