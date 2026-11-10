'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ShopifyMarket, ShopifyMarketLocale } from '@/lib/shopify'
import { saveMappings, type MappingEntry } from '@/app/mapping/actions'
import { getDefaultMappings } from '@/lib/defaultMappings'
import { saveFeedMode } from './actions'

// ── Step constants ─────────────────────────────────────────────────────────

const STEPS = [
  { id: 1, label: 'Name' },
  { id: 2, label: 'Market & language' },
  { id: 3, label: 'Feed mode' },
] as const

// ── Main component ─────────────────────────────────────────────────────────

export function FeedWizardModal({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}) {
  const router = useRouter()
  const [step, setStep] = useState<number>(1)

  // Step 1
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Step 2
  const [markets, setMarkets] = useState<ShopifyMarket[]>([])
  const [loadingMarkets, setLoadingMarkets] = useState(false)
  const [marketsError, setMarketsError] = useState<string | null>(null)
  // Set once markets have loaded: 'feed_url' projects have no markets to pick.
  // Also stops the lazy-load effect from refetching when the list is empty.
  const [marketsSource, setMarketsSource] = useState<'shopify' | 'feed_url' | null>(null)
  const [marketId, setMarketId] = useState('')
  const [locale, setLocale] = useState('en')
  const [currency, setCurrency] = useState('USD')
  const [country, setCountry] = useState('')
  const [marketUrl, setMarketUrl] = useState<string | null>(null)

  // Step 3
  const [feedMode, setFeedMode] = useState<'product' | 'variant'>('product')

  // Submit
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Lazy-load markets when the user actually reaches step 2.
  useEffect(() => {
    if (step !== 2 || marketsSource !== null || loadingMarkets || marketsError) return
    setLoadingMarkets(true)
    fetch(`/api/shopify/markets?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d: { markets?: ShopifyMarket[]; source?: 'feed_url'; error?: string }) => {
        if (d.error) throw new Error(d.error)
        setMarkets(d.markets ?? [])
        setMarketsSource(d.source ?? 'shopify')
      })
      .catch((e: unknown) =>
        setMarketsError(e instanceof Error ? e.message : 'Could not fetch markets')
      )
      .finally(() => setLoadingMarkets(false))
  }, [step, marketsSource, loadingMarkets, marketsError, projectId])

  function selectMarket(m: ShopifyMarket) {
    setMarketId(m.id)
    setCurrency(m.currency)
    setMarketUrl(m.marketUrl ?? null)
    setCountry(m.countryCodes[0] ?? '')
    if (m.defaultLocale) setLocale(m.defaultLocale.locale)
  }

  const selectedMarket = markets.find((m) => m.id === marketId) ?? null
  const availableLocales: ShopifyMarketLocale[] = selectedMarket
    ? [
        ...(selectedMarket.defaultLocale ? [selectedMarket.defaultLocale] : []),
        ...selectedMarket.alternateLocales,
      ]
    : []

  const canNext = step !== 1 || name.trim() !== ''
  const isLast = step === 3

  function next() {
    if (!isLast) {
      setStep((s) => Math.min(3, s + 1))
    } else {
      void submit()
    }
  }

  function back() {
    setStep((s) => Math.max(1, s - 1))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      // 1. Create the feed.
      const feedRes = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          project_id: projectId,
        }),
      })
      const feedData = (await feedRes.json()) as { feed?: { id: string }; error?: string }
      if (!feedRes.ok || feedData.error || !feedData.feed?.id) {
        throw new Error(feedData.error ?? `HTTP ${feedRes.status}`)
      }
      const feedId = feedData.feed.id

      // 2. shop_settings — only when a market was actually selected.
      if (marketId) {
        const settingsRes = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feed_id: feedId,
            selected_market_id: marketId,
            selected_locale: locale,
            selected_country: country,
            currency,
            market_url: marketUrl,
          }),
        })
        if (!settingsRes.ok) {
          console.warn('shop_settings gem fejlede:', await settingsRes.text())
        }
      }

      // 3. feed_mode — always saved (we always have a value).
      const modeResult = await saveFeedMode(feedId, feedMode)
      if (modeResult.error) console.warn('feed_mode gem fejlede:', modeResult.error)

      // 4. Default mappings — wizard always seeds the feed with sensible
      // mappings (id, title, description, link, image_link, availability,
      // price, brand). The wizard has no mapping step today, so there's no
      // user override to honour — saveMappings is invoked unconditionally.
      const defaults: MappingEntry[] = getDefaultMappings(feedMode)
      const mappingsResult = await saveMappings(feedId, defaults)
      if (mappingsResult.error) console.warn('default mappings gem fejlede:', mappingsResult.error)

      // 5. Kick off sync in the background — fire-and-forget. The browser
      // keeps the request alive across the soft navigation below, so the
      // sync runs server-side while the user lands on the new feed page.
      // The ?syncing=1 query param tells FeedClient to show a status banner.
      void fetch(`/api/shopify/sync?feedId=${encodeURIComponent(feedId)}`, {
        method: 'POST',
      }).catch((err) => {
        console.warn('sync kick-off fejlede:', err)
      })

      router.push(`/feed/${feedId}?syncing=1`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create feed')
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.3)' }} />
      <div
        className="relative ff-panel w-full"
        style={{ maxWidth: '600px', maxHeight: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="ff-panel-header"
          style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px' }}
        >
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
            Create new feed
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              fontSize: '16px',
              lineHeight: 1,
              color: 'var(--color-text-tertiary)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        <ProgressBar step={step} />

        <div
          className="px-3.5 py-3.5"
          style={{ flex: 1, overflowY: 'auto', minHeight: '320px' }}
        >
          {step === 1 && (
            <Step1Name
              name={name}
              description={description}
              onName={setName}
              onDescription={setDescription}
            />
          )}
          {step === 2 && (
            <Step2Market
              markets={markets}
              loading={loadingMarkets}
              error={marketsError}
              fromFeedUrl={marketsSource === 'feed_url'}
              marketId={marketId}
              locale={locale}
              currency={currency}
              availableLocales={availableLocales}
              onSelectMarket={selectMarket}
              onLocale={setLocale}
              selectedMarket={selectedMarket}
            />
          )}
          {step === 3 && <Step3Mode mode={feedMode} onMode={setFeedMode} />}

          {error && (
            <p
              className="mt-3"
              style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}
            >
              {error}
            </p>
          )}
        </div>

        <div
          className="px-3.5 py-3 flex items-center justify-between gap-2"
          style={{ borderTop: '1px solid var(--color-border-tertiary)' }}
        >
          <div>
            {step > 1 && (
              <button
                type="button"
                onClick={back}
                disabled={submitting}
                className="ff-btn-secondary"
              >
                Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={next}
              disabled={!canNext || submitting}
              className="ff-btn-primary"
            >
              {submitting ? 'Creating…' : isLast ? 'Create feed' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── ProgressBar ────────────────────────────────────────────────────────────

function ProgressBar({ step }: { step: number }) {
  return (
    <div
      className="px-3.5 py-2.5 flex items-center gap-2"
      style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}
    >
      {STEPS.map((s, i) => {
        const isActive = s.id === step
        const isDone = s.id < step
        return (
          <div key={s.id} className="flex items-center gap-2 flex-1 min-w-0">
            <div
              className="shrink-0 inline-flex items-center justify-center"
              style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                background:
                  isActive || isDone ? 'var(--color-accent)' : 'var(--color-background-secondary)',
                color: isActive || isDone ? '#ffffff' : 'var(--color-text-tertiary)',
                fontSize: '10px',
                fontWeight: 600,
              }}
            >
              {isDone ? '✓' : s.id}
            </div>
            <span
              className="truncate"
              style={{
                fontSize: '11px',
                fontWeight: isActive ? 600 : 400,
                color: isActive
                  ? 'var(--color-text-primary)'
                  : isDone
                    ? 'var(--color-text-secondary)'
                    : 'var(--color-text-tertiary)',
              }}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <div
                className="shrink-0"
                style={{
                  height: '1px',
                  flex: 1,
                  background: isDone ? 'var(--color-accent)' : 'var(--color-border-tertiary)',
                }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Step 1: Name + description ─────────────────────────────────────────────

function Step1Name({
  name,
  description,
  onName,
  onDescription,
}: {
  name: string
  description: string
  onName: (s: string) => void
  onDescription: (s: string) => void
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="ff-label block mb-1.5">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="e.g. Main feed US"
          autoFocus
          className="ff-input"
          required
        />
      </div>
      <div>
        <label className="ff-label block mb-1.5">Description (optional)</label>
        <textarea
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          placeholder="Short description — e.g. which market this feed targets"
          rows={3}
          className="ff-input"
          style={{ resize: 'none' }}
        />
      </div>
    </div>
  )
}

// ── Step 2: Market + locale ────────────────────────────────────────────────

function Step2Market({
  markets,
  loading,
  error,
  fromFeedUrl,
  marketId,
  locale,
  currency,
  availableLocales,
  selectedMarket,
  onSelectMarket,
  onLocale,
}: {
  markets: ShopifyMarket[]
  loading: boolean
  error: string | null
  fromFeedUrl: boolean
  marketId: string
  locale: string
  currency: string
  availableLocales: ShopifyMarketLocale[]
  selectedMarket: ShopifyMarket | null
  onSelectMarket: (m: ShopifyMarket) => void
  onLocale: (s: string) => void
}) {
  return (
    <div className="space-y-3">
      <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
        Choose which Shopify market this feed should use — it controls currency, language and
        country pricing. You can always change it later.
      </p>

      {loading && (
        <div
          className="flex items-center gap-2"
          style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}
        >
          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Loading markets from Shopify…
        </div>
      )}

      {error && (
        <div
          className="p-2.5"
          style={{
            background: 'var(--color-badge-danger-bg)',
            border: '1px solid var(--color-badge-danger-text)',
            borderRadius: '4px',
          }}
        >
          <p style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{error}</p>
        </div>
      )}

      {!loading && !error && fromFeedUrl && (
        <p style={{ fontSize: '12px', color: 'var(--color-text-secondary)' }}>
          This project imports products from a feed URL. Language and currency come from that
          feed, so there is nothing to choose here — continue to the next step.
        </p>
      )}

      {!loading && !error && !fromFeedUrl && markets.length === 0 && (
        <p style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
          No markets found — you can still create the feed and set it up later.
        </p>
      )}

      {markets.length > 0 && (
        <div className="space-y-2">
          {markets.map((market) => (
            <MarketCard
              key={market.id}
              market={market}
              selected={marketId === market.id}
              onSelect={() => onSelectMarket(market)}
            />
          ))}
        </div>
      )}

      {selectedMarket && availableLocales.length > 0 && (
        <div className="grid grid-cols-2 gap-3 pt-1">
          <div>
            <label className="ff-label block mb-1.5">Language</label>
            <select
              value={locale}
              onChange={(e) => onLocale(e.target.value)}
              className="ff-select"
            >
              {availableLocales.map((l) => (
                <option key={l.locale} value={l.locale}>
                  {l.name} ({l.locale}){l.primary ? ' — default' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col justify-end">
            <div
              className="px-3 py-2"
              style={{
                background: 'var(--color-background-secondary)',
                border: '1px solid var(--color-border-tertiary)',
                borderRadius: '4px',
              }}
            >
              <p className="ff-label">Currency</p>
              <p
                className="mt-0.5"
                style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)' }}
              >
                {currency}
                {selectedMarket.currencyName ? ` — ${selectedMarket.currencyName}` : ''}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MarketCard({
  market,
  selected,
  onSelect,
}: {
  market: ShopifyMarket
  selected: boolean
  onSelect: () => void
}) {
  const allLocales = [
    ...(market.defaultLocale ? [market.defaultLocale] : []),
    ...market.alternateLocales,
  ]
  const isPrimary = market.type === 'PRIMARY'
  const isActive = market.status === 'ACTIVE'
  return (
    <label
      className="flex items-start gap-2.5 p-3 cursor-pointer transition-colors"
      style={{
        background: selected ? 'var(--color-badge-accent-bg)' : '#ffffff',
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border-tertiary)'}`,
        borderRadius: '6px',
      }}
    >
      <input
        type="radio"
        checked={selected}
        onChange={onSelect}
        className="mt-0.5 shrink-0"
        style={{ accentColor: '#6c5ce7' }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
            {market.name}
          </span>
          {isPrimary && <span className="ff-badge ff-badge-accent">Primary</span>}
          {!isActive && <span className="ff-badge ff-badge-neutral">Draft</span>}
        </div>
        <div
          className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5"
          style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}
        >
          <span>
            <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)' }}>Currency:</span>{' '}
            {market.currency}
            {market.currencyName ? ` — ${market.currencyName}` : ''}
          </span>
          {allLocales.length > 0 && (
            <span>
              <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)' }}>Languages:</span>{' '}
              {allLocales.map((l) => l.locale).join(', ')}
            </span>
          )}
        </div>
      </div>
    </label>
  )
}

// ── Step 3: Feed mode ──────────────────────────────────────────────────────

function Step3Mode({
  mode,
  onMode,
}: {
  mode: 'product' | 'variant'
  onMode: (m: 'product' | 'variant') => void
}) {
  return (
    <div className="space-y-3">
      <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
        Choose how the feed should be structured. You can always change it later.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <ModeCard
          selected={mode === 'product'}
          title="Product"
          description="One feed item per product. Uses the first variant's data."
          onClick={() => onMode('product')}
        />
        <ModeCard
          selected={mode === 'variant'}
          title="Variant"
          description="One feed item per variant. Groups variants with item_group_id."
          onClick={() => onMode('variant')}
        />
      </div>
    </div>
  )
}

function ModeCard({
  selected,
  title,
  description,
  onClick,
}: {
  selected: boolean
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left p-4 transition-colors"
      style={{
        background: selected ? 'var(--color-badge-accent-bg)' : '#ffffff',
        border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border-tertiary)'}`,
        borderRadius: '6px',
        cursor: 'pointer',
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="inline-flex items-center justify-center shrink-0"
          style={{
            width: '14px',
            height: '14px',
            borderRadius: '50%',
            border: `2px solid ${selected ? 'var(--color-accent)' : 'var(--color-border-secondary)'}`,
            background: selected ? 'var(--color-accent)' : 'transparent',
          }}
        >
          {selected && (
            <span
              style={{
                width: '4px',
                height: '4px',
                borderRadius: '50%',
                background: '#ffffff',
              }}
            />
          )}
        </span>
        <span
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--color-text-primary)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          {title}
        </span>
      </div>
      <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
        {description}
      </p>
    </button>
  )
}

