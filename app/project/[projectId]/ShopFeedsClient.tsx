'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { FeedWizardModal } from '@/app/dashboard/FeedWizardModal'
import { ProjectConnectModal, type ConnectResult, type ProjectSource } from '@/app/components/ProjectConnectModal'
import { ChannelIcon } from '@/app/components/ChannelIcon'
import { Popover } from '@/app/components/shell/Popover'
import { flagEmoji } from '@/app/components/shell/nav'
import { channelOf } from '@/lib/channels'
import { countryName, formatNumber, formatWhen, languageName } from '@/lib/formatDa'
import { staleSyncDays } from '@/lib/syncSchedule'
import type { ShopifyMarket } from '@/lib/shopify'
import type { MissingScope } from '@/lib/shopifyScopes'
import type { ValidationIssue } from '@/lib/feedValidator'
import { DeleteFeedDialog, DescribeFeedDialog, RenameFeedDialog, type PatchedFeed } from './FeedModals'
import type { FeedListItem } from '@/lib/feedList'
import './feeds.css'

// Shop level › Feeds. Every feed of the shop in one table, grouped by market
// (GUIDELINES §2, reference references/shop_feeds.jpg). The shop's product
// source sits at the top of the same card.

type FeedRow = {
  id: string
  name: string
  description: string | null
  channel: string
  market: { marketId: string | null; country: string | null; locale: string | null; currency: string | null } | null
  lastSynced: string | null
  feedGenerated: string | null
  feedProductCount: number | null
  excludedCount: number | null
  validationStatus: 'ok' | 'warnings' | 'errors' | null
  validationErrors: ValidationIssue[] | null
}

type Group = {
  key: string
  title: string
  country: string | null
  meta: string
  marketId: string | null
  feeds: FeedRow[]
}

export function ShopFeedsClient({
  projectId,
  projectName,
  shopUrl: initialShopUrl,
  sourceType: initialSourceType,
  feedUrl: initialFeedUrl,
  connectionStatus: initialStatus,
  lastVerifiedAt: initialVerifiedAt,
  initialFeeds,
}: {
  projectId: string
  projectName: string
  shopUrl: string | null
  sourceType: ProjectSource
  feedUrl: string | null
  connectionStatus: string
  lastVerifiedAt: string | null
  /** The list, rendered with the page; null makes the client fetch it. */
  initialFeeds?: FeedListItem[] | null
}) {
  const [shopUrl, setShopUrl] = useState(initialShopUrl)
  const [sourceType, setSourceType] = useState<ProjectSource>(initialSourceType)
  const [feedUrl, setFeedUrl] = useState(initialFeedUrl)
  const [status, setStatus] = useState(initialStatus)
  const [lastVerifiedAt, setLastVerifiedAt] = useState(initialVerifiedAt)
  const [missing, setMissing] = useState<MissingScope[]>([])
  const [productCount, setProductCount] = useState<number | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  // undefined = closed; '' = open with no market preselected.
  const [wizardMarket, setWizardMarket] = useState<string | undefined>(undefined)

  const [feeds, setFeeds] = useState<FeedRow[] | null>((initialFeeds as FeedRow[] | null | undefined) ?? null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [markets, setMarkets] = useState<ShopifyMarket[] | null>(null)

  const connected = status === 'connected'
  const isFeedUrl = sourceType === 'feed_url'

  // Feeds first (fast), then the slow per-feed excluded counts.
  useEffect(() => {
    let cancelled = false
    // The list usually came with the page; otherwise fetch it.
    const listed = initialFeeds
      ? Promise.resolve({ feeds: initialFeeds as FeedRow[] })
      : fetch(`/api/feeds?projectId=${encodeURIComponent(projectId)}`).then((r) => r.json())
    listed
      .then((d: { feeds?: (Omit<FeedRow, 'excludedCount'> & { excludedCount: number | null })[]; error?: string }) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setFeeds(d.feeds ?? [])
        return fetch(`/api/feeds/counts?projectId=${encodeURIComponent(projectId)}`)
          .then((r) => r.json())
          .then((c: { counts?: { feedId: string; excluded: number }[] }) => {
            if (cancelled) return
            const byId = new Map((c.counts ?? []).map((x) => [x.feedId, x.excluded] as const))
            setFeeds((prev) => prev?.map((f) => ({ ...f, excludedCount: byId.get(f.id) ?? f.excludedCount })) ?? prev)
          })
          .catch(() => {})
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load feeds')
      })
    return () => {
      cancelled = true
    }
  }, [projectId, initialFeeds])

  // Shopify markets, so markets without feeds get a row too. Read-only.
  useEffect(() => {
    if (!connected || isFeedUrl) return
    let cancelled = false
    fetch(`/api/shopify/markets?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d: { markets?: ShopifyMarket[] }) => {
        if (!cancelled) setMarkets(d.markets ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId, connected, isFeedUrl])

  // Missing Shopify scopes are read live (advisory; failures stay silent).
  useEffect(() => {
    if (!connected || isFeedUrl) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/connect`)
      .then((r) => r.json())
      .then((d: { missingScopes?: MissingScope[] }) => {
        if (!cancelled) setMissing(d.missingScopes ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId, connected, isFeedUrl])

  function handleConnected(result: ConnectResult) {
    setStatus(result.connection_status)
    setLastVerifiedAt(result.last_verified_at)
    setSourceType(result.source_type)
    if (result.source_type === 'feed_url') {
      setFeedUrl(result.feedUrl)
      setShopUrl(null)
    } else {
      setShopUrl(result.shop)
      setFeedUrl(null)
    }
    setProductCount(result.productCount)
    setMissing(result.missingScopes)
  }

  function patched(u: PatchedFeed) {
    setFeeds((prev) => prev?.map((f) => (f.id === u.id ? { ...f, name: u.name, description: u.description } : f)) ?? prev)
  }
  function deleted(id: string) {
    setFeeds((prev) => prev?.filter((f) => f.id !== id) ?? prev)
  }

  const sourceLabel = isFeedUrl ? feedUrl : shopUrl
  const groups = feeds ? groupFeeds(feeds, markets) : []
  const canCreate = connected

  return (
    <div className="sf">
      <div className="sf-head">
        <div>
          <h1>Feeds</h1>
          <p className="sf-lede">
            All the shop&apos;s feeds in one list, grouped by market. Click a feed to work on that
            feed.
          </p>
        </div>
        <div className="sf-actions">
          <button type="button" className="wl-btn-secondary" onClick={() => setConnectOpen(true)}>
            {connected ? 'Change source' : 'Connect source'}
          </button>
          <button
            type="button"
            className="wl-btn-primary"
            disabled={!canCreate}
            title={canCreate ? undefined : 'Connect a source first'}
            onClick={() => setWizardMarket('')}
          >
            + New feed
          </button>
        </div>
      </div>

      {/* Set by sync when Shopify answers 401 (lib/sync.ts): no feed in the
          shop can update until a new token is pasted. */}
      {status === 'error' && !isFeedUrl && (
        <p className="note warn">
          <b>Shopify rejected the access token.</b> None of the shop&apos;s feeds can sync until it is
          replaced. The app has probably been uninstalled, or the token rotated in Shopify Admin. Create a new
          read-only token there and paste it under Change source.
        </p>
      )}
      {!connected && status !== 'error' && (
        <p className="note">
          Connect the shop to a source before you create feeds: a Shopify store with a read-only token or
          a public product feed URL.
        </p>
      )}
      {connected && isFeedUrl && productCount !== null && (
        <p className="note">Feed URL checked: {formatNumber(productCount)} products found.</p>
      )}
      {connected &&
        !isFeedUrl &&
        missing.map((s) => (
          <p key={s.handle} className={s.required ? 'note warn' : 'note'}>
            The Shopify token is missing the <b>{s.handle}</b> scope. {s.impact}
          </p>
        ))}

      <section className="card flush sf-card">
        <div className="sf-source">
          <div className="sf-source-text">
            <b>{projectName}</b>
            <small>
              {[
                sourceLabel,
                isFeedUrl ? 'Feed URL' : connected ? 'Shopify Markets' : null,
                lastVerifiedAt ? `checked ${formatWhen(lastVerifiedAt)}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'No source yet'}
            </small>
          </div>
          {status === 'connected' ? (
            <span className="st">Source OK</span>
          ) : status === 'error' ? (
            <span className="neg">Source failing</span>
          ) : (
            <span className="pill warn">Not connected</span>
          )}
        </div>

        {loadError ? (
          <p className="sf-empty neg">{loadError}</p>
        ) : feeds === null ? (
          <p className="sf-empty">Loading feeds…</p>
        ) : groups.length === 0 ? (
          <div className="sf-empty">
            <p>This shop has no feeds yet.</p>
            {canCreate && (
              <button type="button" className="wl-btn-primary" onClick={() => setWizardMarket('')}>
                Create first feed
              </button>
            )}
          </div>
        ) : (
          <div className="sf-tablewrap">
            <table className="sf-table">
              <thead>
                <tr>
                  <th>Feed</th>
                  <th>Status</th>
                  <th className="r">Products in feed</th>
                  <th className="r">Excluded</th>
                  <th className="r">Synced</th>
                  <th className="r">Generated</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.key}>
                  <tr className="sf-grp">
                    <td colSpan={6}>
                      <span className="sf-grp-title">
                        {g.country && <span className="sf-flag">{flagEmoji(g.country)}</span>}
                        <b>{g.title}</b>
                        {g.meta && <span className="sf-grp-meta">{g.meta}</span>}
                      </span>
                    </td>
                    <td className="r">
                      {canCreate && (
                        <button type="button" className="sf-add" onClick={() => setWizardMarket(g.marketId ?? '')}>
                          + New feed
                        </button>
                      )}
                    </td>
                  </tr>
                  {g.feeds.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="sf-none">
                        No feeds in {g.title} yet.
                      </td>
                    </tr>
                  ) : (
                    g.feeds.map((f) => <FeedTableRow key={f.id} feed={f} onPatched={patched} onDeleted={deleted} />)
                  )}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </section>
      {feeds && feeds.length > 0 && (
        <p className="sf-foot">
          Excluded are products removed by the rules under Include / exclude. Synced is the last
          fetch from the source.
        </p>
      )}

      {wizardMarket !== undefined && (
        <FeedWizardModal
          projectId={projectId}
          initialMarketId={wizardMarket || undefined}
          onClose={() => setWizardMarket(undefined)}
        />
      )}
      {connectOpen && (
        <ProjectConnectModal
          projectId={projectId}
          mode={connected ? 'rotate' : 'connect'}
          initialSource={sourceType}
          initialShopUrl={shopUrl}
          initialFeedUrl={feedUrl}
          onClose={() => setConnectOpen(false)}
          onConnected={handleConnected}
        />
      )}
    </div>
  )
}

// ── Grouping ────────────────────────────────────────────────────────────────

function marketMeta(locale: string | null | undefined, currency: string | null | undefined, extra?: string): string {
  return [languageName(locale), currency, extra].filter(Boolean).join(' · ')
}

// With Shopify markets: one group per market (in Shopify's order), including
// active markets that have no feeds yet, plus a group for feeds whose market is
// unknown. Without markets (feed-URL shops, or markets not loaded): group by
// the feed's country.
function groupFeeds(feeds: FeedRow[], markets: ShopifyMarket[] | null): Group[] {
  if (markets && markets.length > 0) {
    const used = new Set<string>()
    const groups: Group[] = []
    for (const m of markets) {
      const inMarket = feeds.filter((f) => f.market?.marketId === m.id)
      inMarket.forEach((f) => used.add(f.id))
      if (inMarket.length === 0 && m.status !== 'ACTIVE') continue
      const single = m.countryCodes.length === 1 ? m.countryCodes[0] : null
      groups.push({
        key: m.id,
        title: single ? countryName(single) : m.name,
        country: single,
        meta: marketMeta(
          m.defaultLocale?.locale,
          m.currency,
          single ? undefined : `${m.countryCodes.length} countries`
        ),
        marketId: m.id,
        feeds: inMarket,
      })
    }
    const rest = feeds.filter((f) => !used.has(f.id))
    if (rest.length) groups.push(...groupByCountry(rest, 'other'))
    return groups
  }
  return groupByCountry(feeds, 'c')
}

function groupByCountry(feeds: FeedRow[], prefix: string): Group[] {
  const by = new Map<string, FeedRow[]>()
  for (const f of feeds) {
    const k = f.market?.country ?? ''
    by.set(k, [...(by.get(k) ?? []), f])
  }
  return [...by.entries()].map(([country, list]) => ({
    key: `${prefix}:${country}`,
    title: country ? countryName(country) : 'No market',
    country: country || null,
    meta: marketMeta(list[0].market?.locale, list[0].market?.currency),
    marketId: list[0].market?.marketId ?? null,
    feeds: list,
  }))
}

// ── One feed row ────────────────────────────────────────────────────────────

function FeedStatus({ feed }: { feed: FeedRow }) {
  if (staleSyncDays(feed.lastSynced) != null) return <span className="neg">Sync failing</span>
  if (!feed.feedGenerated) return <span className="st st-off">Not generated</span>
  const issues = feed.validationErrors ?? []
  if (feed.validationStatus === 'errors') {
    const n = issues.filter((i) => i.type === 'error').length
    return <span className="neg">{n ? `${formatNumber(n)} ${n === 1 ? 'error' : 'errors'}` : 'Errors'}</span>
  }
  if (feed.validationStatus === 'warnings') {
    const n = issues.filter((i) => i.type === 'warning').length
    return <span className="neg">{n ? `${formatNumber(n)} ${n === 1 ? 'warning' : 'warnings'}` : 'Warnings'}</span>
  }
  return <span className="st">Ready</span>
}

function FeedTableRow({
  feed,
  onPatched,
  onDeleted,
}: {
  feed: FeedRow
  onPatched: (u: PatchedFeed) => void
  onDeleted: (id: string) => void
}) {
  const router = useRouter()
  const [dialog, setDialog] = useState<'rename' | 'describe' | 'delete' | null>(null)
  const [copied, setCopied] = useState(false)
  const href = `/feed/${feed.id}`
  const stale = staleSyncDays(feed.lastSynced)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/api/feed/generate/${feed.id}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: nothing to do.
    }
  }

  // Clicks inside the action cell must not also open the feed.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <tr
      className="sf-row"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          router.push(href)
        }
      }}
    >
      <td>
        <span className="sf-feed">
          <ChannelIcon channel={feed.channel} />
          <span>
            <b>{channelOf(feed.channel).label}</b>
            <small>{feed.description ? `${feed.name} · ${feed.description}` : feed.name}</small>
          </span>
        </span>
      </td>
      <td>
        <FeedStatus feed={feed} />
      </td>
      <td className="r num">{feed.feedProductCount != null && feed.feedGenerated ? formatNumber(feed.feedProductCount) : <span className="sf-muted">—</span>}</td>
      <td className="r num">
        {feed.excludedCount == null ? (
          <span className="sf-muted">…</span>
        ) : feed.excludedCount === 0 ? (
          <span className="sf-muted">0</span>
        ) : (
          formatNumber(feed.excludedCount)
        )}
      </td>
      <td className={`r${stale != null ? ' neg' : ''}`} title={stale != null ? `${stale} days old` : undefined}>
        {feed.lastSynced ? formatWhen(feed.lastSynced) : <span className="sf-muted">never</span>}
      </td>
      <td className="r">{feed.feedGenerated ? formatWhen(feed.feedGenerated) : <span className="sf-muted">—</span>}</td>
      <td className="r sf-act" onClick={stop} onKeyDown={stop}>
        <Link href={href} className="link">
          Open feed
        </Link>
        <Popover
          label={`More actions for ${feed.name}`}
          align="right"
          triggerClassName="sf-more"
          trigger={<span aria-hidden="true">⋯</span>}
        >
          {(close) => (
            <>
              <button type="button" role="menuitem" className="shell-menu-item" onClick={() => { void copyLink(); close() }}>
                Copy feed link
              </button>
              <button type="button" role="menuitem" className="shell-menu-item" onClick={() => { close(); setDialog('rename') }}>
                Rename
              </button>
              <button type="button" role="menuitem" className="shell-menu-item" onClick={() => { close(); setDialog('describe') }}>
                Edit description
              </button>
              <button type="button" role="menuitem" className="shell-menu-item neg" onClick={() => { close(); setDialog('delete') }}>
                Delete feed
              </button>
            </>
          )}
        </Popover>
        {copied && <span className="sf-copied" role="status">✓ Copied</span>}
        {dialog === 'rename' && (
          <RenameFeedDialog feed={feed} onClose={() => setDialog(null)} onSaved={(u) => { onPatched(u); setDialog(null) }} />
        )}
        {dialog === 'describe' && (
          <DescribeFeedDialog feed={feed} onClose={() => setDialog(null)} onSaved={(u) => { onPatched(u); setDialog(null) }} />
        )}
        {dialog === 'delete' && (
          <DeleteFeedDialog feed={feed} onClose={() => setDialog(null)} onDeleted={() => { onDeleted(feed.id); setDialog(null) }} />
        )}
      </td>
    </tr>
  )
}
