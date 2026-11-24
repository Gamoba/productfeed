'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ShopifyMarket, ShopifyMarketLocale } from '@/lib/shopify'
import { saveMappings, type MappingEntry } from '@/app/mapping/actions'
import { getDefaultMappings } from '@/lib/defaultMappings'
import { CHANNEL_IDS, CHANNELS, channelAvailability, type ChannelId } from '@/lib/channels'
import { ChannelIcon } from '@/app/components/ChannelIcon'
import { saveFeedMode } from './actions'
import './FeedWizardModal.css'

// "Add new feed": a feed is one channel in one market (GUIDELINES §3).
// Step 1 picks the market, step 2 the channel (filtered by the channel ×
// country rules in lib/channels.ts), step 3 the name and structure.

const STEPS = [
  { id: 1, label: 'Market' },
  { id: 2, label: 'Channel' },
  { id: 3, label: 'Name' },
] as const

export function FeedWizardModal({
  projectId,
  initialMarketId,
  onClose,
}: {
  projectId: string
  // Preselect a market, e.g. when opened from that market's row on Feeds.
  initialMarketId?: string
  onClose: () => void
}) {
  const router = useRouter()
  const [step, setStep] = useState<number>(1)

  // Step 1: market. Loaded once on open; feed-URL projects have no markets.
  const [markets, setMarkets] = useState<ShopifyMarket[]>([])
  const [loadingMarkets, setLoadingMarkets] = useState(true)
  const [marketsError, setMarketsError] = useState<string | null>(null)
  const [marketsSource, setMarketsSource] = useState<'shopify' | 'feed_url' | null>(null)
  const [marketId, setMarketId] = useState('')
  const [locale, setLocale] = useState('en')
  const [currency, setCurrency] = useState('USD')
  const [country, setCountry] = useState('')
  const [marketUrl, setMarketUrl] = useState<string | null>(null)

  // Step 2: channel
  const [channel, setChannel] = useState<ChannelId>('google_shopping')

  // Step 3: name + structure
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [feedMode, setFeedMode] = useState<'product' | 'variant'>('product')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function selectMarket(m: ShopifyMarket) {
    setMarketId(m.id)
    setCurrency(m.currency)
    setMarketUrl(m.marketUrl ?? null)
    setCountry(m.countryCodes[0] ?? '')
    if (m.defaultLocale) setLocale(m.defaultLocale.locale)
  }

  useEffect(() => {
    let cancelled = false
    fetch(`/api/shopify/markets?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((d: { markets?: ShopifyMarket[]; source?: 'feed_url'; error?: string }) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        const list = d.markets ?? []
        setMarkets(list)
        setMarketsSource(d.source ?? 'shopify')
        const preset = list.find((m) => m.id === initialMarketId)
        if (preset) selectMarket(preset)
      })
      .catch((e: unknown) => {
        if (!cancelled) setMarketsError(e instanceof Error ? e.message : 'The markets could not be fetched')
      })
      .finally(() => {
        if (!cancelled) setLoadingMarkets(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, initialMarketId])

  const selectedMarket = markets.find((m) => m.id === marketId) ?? null
  const availableLocales: ShopifyMarketLocale[] = selectedMarket
    ? [
        ...(selectedMarket.defaultLocale ? [selectedMarket.defaultLocale] : []),
        ...selectedMarket.alternateLocales,
      ]
    : []

  const channelOk = channelAvailability(channel, country).available
  // A Shopify project must pick a market: the feed is for one market.
  const needsMarket = marketsSource === 'shopify' && markets.length > 0
  const canNext =
    step === 1
      ? !loadingMarkets && (!needsMarket || !!marketId)
      : step === 2
        ? channelOk
        : name.trim() !== ''
  const isLast = step === 3

  function suggestedName(): string {
    return [CHANNELS[channel].label, country].filter(Boolean).join(' · ')
  }

  function next() {
    if (isLast) {
      void submit()
      return
    }
    if (step === 2 && !name.trim()) setName(suggestedName())
    setStep((s) => Math.min(3, s + 1))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      // 1. The feed, with its channel. The server checks the channel may be
      //    used in the market's country.
      const feedRes = await fetch('/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          project_id: projectId,
          channel,
          country: country || null,
        }),
      })
      const feedData = (await feedRes.json()) as { feed?: { id: string }; error?: string }
      if (!feedRes.ok || feedData.error || !feedData.feed?.id) {
        throw new Error(feedData.error ?? `HTTP ${feedRes.status}`)
      }
      const feedId = feedData.feed.id

      // 2. The market (shop_settings), when one was chosen.
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
        if (!settingsRes.ok) console.warn('shop_settings gem fejlede:', await settingsRes.text())
      }

      // 3. Feed mode.
      const modeResult = await saveFeedMode(feedId, feedMode)
      if (modeResult.error) console.warn('feed_mode gem fejlede:', modeResult.error)

      // 4. Default mappings (id, title, description, link, image_link,
      //    availability, price, brand).
      const defaults: MappingEntry[] = getDefaultMappings(feedMode)
      const mappingsResult = await saveMappings(feedId, defaults)
      if (mappingsResult.error) console.warn('default mappings gem fejlede:', mappingsResult.error)

      // 5. First sync, fire-and-forget; the feed page shows a banner meanwhile.
      void fetch(`/api/shopify/sync?feedId=${encodeURIComponent(feedId)}`, { method: 'POST' }).catch(
        (err) => console.warn('sync kick-off fejlede:', err)
      )

      router.push(`/feed/${feedId}?syncing=1`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The feed could not be created')
      setSubmitting(false)
    }
  }

  return (
    <div className="fw-overlay" onClick={onClose}>
      <div
        className="fw-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fw-head">
          <div>
            <h2 id="fw-title">New feed</h2>
            <p>A feed is one channel in one market.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="fw-x">
            ×
          </button>
        </div>

        <ol className="fw-steps">
          {STEPS.map((s) => (
            <li
              key={s.id}
              className={s.id < step ? 'done' : undefined}
              aria-current={s.id === step ? 'step' : undefined}
            >
              <i>{s.id < step ? '✓' : s.id}</i>
              {s.label}
            </li>
          ))}
        </ol>

        <div className="fw-body">
          {step === 1 && (
            <StepMarket
              markets={markets}
              loading={loadingMarkets}
              error={marketsError}
              fromFeedUrl={marketsSource === 'feed_url'}
              marketId={marketId}
              locale={locale}
              currency={currency}
              availableLocales={availableLocales}
              selectedMarket={selectedMarket}
              onSelectMarket={selectMarket}
              onLocale={setLocale}
            />
          )}
          {step === 2 && <StepChannel channel={channel} country={country} onChannel={setChannel} />}
          {step === 3 && (
            <StepName
              name={name}
              description={description}
              mode={feedMode}
              onName={setName}
              onDescription={setDescription}
              onMode={setFeedMode}
            />
          )}
          {error && <p className="fw-error">{error}</p>}
        </div>

        <div className="fw-foot">
          <span className="fw-foot-note">Step {step} of 3</span>
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
              disabled={submitting}
              className="ff-btn-secondary"
            >
              Back
            </button>
          )}
          <button type="button" onClick={next} disabled={!canNext || submitting} className="ff-btn-primary">
            {submitting ? 'Creating…' : isLast ? 'Create feed' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Step 1: market ──────────────────────────────────────────────────────────

function StepMarket({
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
    <div className="fw-stack">
      <p className="fw-lede">
        Which market is the feed for? The market sets country, language, currency and prices.
      </p>

      {loading && <p className="fw-muted">Fetching markets from Shopify…</p>}
      {error && <p className="note warn">{error}</p>}

      {!loading && !error && fromFeedUrl && (
        <p className="note">
          The shop fetches products from a feed URL. Language and currency come from that feed, so there is
          no market to choose. Continue to channel.
        </p>
      )}
      {!loading && !error && !fromFeedUrl && markets.length === 0 && (
        <p className="note">The shop has no markets. You can still create the feed.</p>
      )}

      {markets.length > 0 && (
        <div className="fw-options" role="radiogroup" aria-label="Market">
          {markets.map((m) => {
            const locales = [...(m.defaultLocale ? [m.defaultLocale] : []), ...m.alternateLocales]
            const selected = marketId === m.id
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className="fw-option"
                onClick={() => onSelectMarket(m)}
              >
                <span className="fw-option-main">
                  <b>{m.name}</b>
                  <small>
                    {[
                      m.countryCodes.slice(0, 4).join(', ') + (m.countryCodes.length > 4 ? ' …' : ''),
                      m.currency,
                      locales.map((l) => l.locale).join(', '),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
                {m.type === 'PRIMARY' && <span className="pill">Primary</span>}
                {m.status !== 'ACTIVE' && <span className="pill">Draft</span>}
              </button>
            )
          })}
        </div>
      )}

      {selectedMarket && availableLocales.length > 0 && (
        <div className="fw-row">
          <label className="fw-field">
            <span>Language</span>
            <select value={locale} onChange={(e) => onLocale(e.target.value)} className="ff-select">
              {availableLocales.map((l) => (
                <option key={l.locale} value={l.locale}>
                  {l.name} ({l.locale}){l.primary ? ', default' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="fw-field">
            <span>Currency</span>
            <p className="fw-static">
              {currency}
              {selectedMarket.currencyName ? ` · ${selectedMarket.currencyName}` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Step 2: channel ─────────────────────────────────────────────────────────

function StepChannel({
  channel,
  country,
  onChannel,
}: {
  channel: ChannelId
  country: string
  onChannel: (c: ChannelId) => void
}) {
  return (
    <div className="fw-stack">
      <p className="fw-lede">
        Where will the feed be used?{country ? ` Showing what can be used in ${country}.` : ''}
      </p>
      <div className="fw-options" role="radiogroup" aria-label="Channel">
        {CHANNEL_IDS.map((id) => {
          const c = CHANNELS[id]
          const avail = channelAvailability(id, country)
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={channel === id}
              disabled={!avail.available}
              className="fw-option"
              onClick={() => onChannel(id)}
            >
              <ChannelIcon channel={id} size={28} />
              <span className="fw-option-main">
                <b>{c.label}</b>
                <small className={avail.available ? undefined : 'neg'}>
                  {avail.available ? c.description : avail.reason}
                </small>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Step 3: name + structure ────────────────────────────────────────────────

function StepName({
  name,
  description,
  mode,
  onName,
  onDescription,
  onMode,
}: {
  name: string
  description: string
  mode: 'product' | 'variant'
  onName: (s: string) => void
  onDescription: (s: string) => void
  onMode: (m: 'product' | 'variant') => void
}) {
  return (
    <div className="fw-stack">
      <label className="fw-field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => onName(e.target.value)}
          autoFocus
          className="ff-input"
          required
        />
      </label>
      <label className="fw-field">
        <span>Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => onDescription(e.target.value)}
          rows={2}
          className="ff-input"
          style={{ resize: 'none' }}
        />
      </label>
      <div className="fw-field">
        <span>Structure</span>
        <div className="fw-options fw-options-2" role="radiogroup" aria-label="Structure">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'product'}
            className="fw-option"
            onClick={() => onMode('product')}
          >
            <span className="fw-option-main">
              <b>Per product</b>
              <small>One line per product. Uses the first variant’s data.</small>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'variant'}
            className="fw-option"
            onClick={() => onMode('variant')}
          >
            <span className="fw-option-main">
              <b>Per variant</b>
              <small>One line per variant, grouped with item_group_id.</small>
            </span>
          </button>
        </div>
      </div>
      <p className="fw-muted">The channel is fixed. Name, market and structure can be changed afterwards.</p>
    </div>
  )
}
