'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ShopifyMarket, ShopifyMarketLocale } from '@/lib/shopify'
import { saveAutoSyncSchedule, saveFeedMode, saveGoogleAdsSchedule } from '@/app/dashboard/actions'
import { SyncProgressBar, useFeedSync } from '@/app/components/SyncProgress'
import { AUTO_SYNC_FREQUENCIES, AUTO_SYNC_LABELS, type AutoSyncFrequency } from '@/lib/syncSchedule'
import { countryName, formatWhen, languageName } from '@/lib/formatDa'
import { flagEmoji } from '@/app/components/shell/nav'
import './settings.css'
import { markFeedEdited } from '@/lib/recentEdit'
import { refreshShell } from '@/app/components/shell/useShell'

export type ScheduleState = {
  frequency: AutoSyncFrequency
  time: string
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
}

type ShopSettings = {
  selected_market_id: string | null
  selected_locale: string
  selected_country: string
  currency: string
  market_url: string | null
}

type AdsState = {
  hasConnection: boolean
  connectionError: string | null
  customerId: string | null
  customerName: string | null
  currencyCode: string | null
  feedLabel: string | null
  roas: string[]
  poas: string[]
  lastSyncedAt: string | null
  lastSyncError: string | null
}

type Account = {
  customerId: string
  name: string
  currencyCode: string
  viaManager: string | null
  managerName: string | null
}

type Action = { name: string; value: number; inWindow: boolean }

type Props = {
  feedId: string
  projectId: string | null
  source: { type: 'shopify' | 'feed_url'; address: string | null; lastSyncedAt: string | null }
  initialShop: ShopSettings | null
  initialFeedMode: 'product' | 'variant'
  feedSchedule: ScheduleState
  perfSchedule: ScheduleState
  ads: AdsState
  actions: Action[]
}

const fmtId = (id: string) => (id.length === 10 ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id)
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
// A set of actions as one <select> value. \u0001 cannot occur in an action name.
const SEP = '\u0001'

export function SettingsClient({
  feedId,
  projectId,
  source,
  initialShop,
  initialFeedMode,
  feedSchedule,
  perfSchedule,
  ads,
  actions,
}: Props) {
  const router = useRouter()

  // ── Kilde ──
  const [shop, setShop] = useState<ShopSettings | null>(initialShop)
  const [savedShop, setSavedShop] = useState<ShopSettings | null>(initialShop)
  const [editingSource, setEditingSource] = useState(false)
  const [markets, setMarkets] = useState<ShopifyMarket[] | null>(null)
  const [marketsError, setMarketsError] = useState<string | null>(null)
  const [fromFeedUrl, setFromFeedUrl] = useState(false)

  // ── Tidsplan ──
  const [feedFreq, setFeedFreq] = useState(feedSchedule.frequency)
  const [feedTime, setFeedTime] = useState(feedSchedule.time)
  const [perfFreq, setPerfFreq] = useState(perfSchedule.frequency)
  const [perfTime, setPerfTime] = useState(perfSchedule.time)
  const [feedMode, setFeedMode] = useState(initialFeedMode)
  const [saved, setSaved] = useState({
    feedFreq: feedSchedule.frequency,
    feedTime: feedSchedule.time,
    perfFreq: perfSchedule.frequency,
    perfTime: perfSchedule.time,
    feedMode: initialFeedMode,
  })

  // ── Google Ads ──
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [accountsState, setAccountsState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [customerId, setCustomerId] = useState(ads.customerId ?? '')
  const [feedLabel, setFeedLabel] = useState(ads.feedLabel ?? '')
  const [roas, setRoas] = useState<string[]>(ads.roas)
  const [poas, setPoas] = useState<string[]>(ads.poas)

  // ── Save / sync ──
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const shopDirty =
    !!shop &&
    (shop.selected_market_id !== savedShop?.selected_market_id || shop.selected_locale !== savedShop?.selected_locale)
  const feedSchedDirty = feedFreq !== saved.feedFreq || feedTime !== saved.feedTime
  const perfSchedDirty = !!ads.customerId && (perfFreq !== saved.perfFreq || perfTime !== saved.perfTime)
  const modeDirty = feedMode !== saved.feedMode
  const accountChanged = customerId !== (ads.customerId ?? '')
  const labelChanged = feedLabel.trim() !== (ads.feedLabel ?? '')
  const adsDirty = !!customerId && (accountChanged || labelChanged || !sameSet(roas, ads.roas) || !sameSet(poas, ads.poas))
  const dirty = shopDirty || feedSchedDirty || perfSchedDirty || modeDirty || adsDirty

  const sync = useFeedSync(feedId, {
    onFinished: (outcome) => {
      if (!outcome.ok) {
        setStatus({ kind: 'error', text: outcome.error })
        return
      }
      const r = outcome.result
      setStatus({
        kind: 'ok',
        text: r ? `Synced: ${r.synced} products in ${(r.durationMs / 1000).toFixed(1)} s` : 'Synced',
      })
      router.refresh()
      refreshShell()
    },
  })

  // Markets are fetched from Shopify only when someone opens the editor, not
  // on every visit to the page.
  function openSourceEditor() {
    setEditingSource((v) => !v)
    if (markets || !projectId) return
    fetch(`/api/shopify/markets?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => r.json())
      .then((data: { markets?: ShopifyMarket[]; source?: 'feed_url'; error?: string }) => {
        if (data.error) throw new Error(data.error)
        setFromFeedUrl(data.source === 'feed_url')
        const list = data.markets ?? []
        setMarkets(list)
        // A saved market without url/country (older rows) would send blanks
        // back on the next save; fill them from the live market.
        const match = list.find((m) => m.id === shop?.selected_market_id)
        if (match && shop) {
          setShop({
            ...shop,
            market_url: shop.market_url ?? match.marketUrl ?? null,
            selected_country: shop.selected_country || match.countryCodes[0] || '',
          })
        }
      })
      .catch((err: unknown) => setMarketsError(err instanceof Error ? err.message : 'Could not fetch markets'))
  }

  function selectMarket(m: ShopifyMarket) {
    setShop({
      selected_market_id: m.id,
      selected_locale: m.defaultLocale?.locale ?? shop?.selected_locale ?? 'en',
      selected_country: m.countryCodes[0] ?? '',
      currency: m.currency,
      market_url: m.marketUrl ?? null,
    })
  }

  const selectedMarket = markets?.find((m) => m.id === shop?.selected_market_id) ?? null
  const locales: ShopifyMarketLocale[] = selectedMarket
    ? [...(selectedMarket.defaultLocale ? [selectedMarket.defaultLocale] : []), ...selectedMarket.alternateLocales]
    : []

  function loadAccounts() {
    if (accounts || accountsState === 'loading' || !ads.hasConnection) return
    setAccountsState('loading')
    fetch(`/api/google-ads/${feedId}/accounts`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error)
        setAccounts(j.accounts ?? [])
        setAccountsState('idle')
      })
      .catch(() => setAccountsState('error'))
  }

  async function save(): Promise<boolean> {
    setSaving(true)
    setStatus(null)
    try {
      if (shopDirty && shop) {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feed_id: feedId, ...shop }),
        })
        const data = (await res.json()) as { error?: string }
        if (data.error) throw new Error(data.error)
        setSavedShop(shop)
      }
      if (modeDirty) {
        const r = await saveFeedMode(feedId, feedMode)
        if (r.error) throw new Error(r.error)
        markFeedEdited(feedId)
      }
      if (feedSchedDirty) {
        const r = await saveAutoSyncSchedule(feedId, feedFreq, feedTime)
        if (r.error) throw new Error(r.error)
      }
      let note = ''
      if (adsDirty) {
        const account = accounts?.find((a) => a.customerId === customerId)
        // A different account or filter means different numbers, so fetch
        // them now rather than at the next scheduled run.
        const refetch = accountChanged || labelChanged
        const res = await fetch(`/api/google-ads/${feedId}/settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The route replaces every field, so send all of them.
          body: JSON.stringify({
            customerId,
            customerName: account?.name ?? ads.customerName,
            currencyCode: account?.currencyCode ?? ads.currencyCode,
            loginCustomerId: account?.viaManager ?? null,
            feedLabel: feedLabel.trim() || null,
            roasConversionActions: roas,
            poasConversionActions: poas,
            syncNow: refetch,
          }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Could not save the Google Ads account')
        if (json.syncError) note = ` The figures could not be fetched: ${json.syncError}`
      }
      if (perfSchedDirty) {
        const r = await saveGoogleAdsSchedule(feedId, perfFreq, perfTime)
        if (r.error) throw new Error(r.error)
      }
      setSaved({ feedFreq, feedTime, perfFreq, perfTime, feedMode })
      setStatus({ kind: note ? 'error' : 'ok', text: `Saved.${note}` })
      router.refresh()
      refreshShell()
      return true
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save' })
      return false
    } finally {
      setSaving(false)
    }
  }

  // Market and language decide what is fetched, so a change there only takes
  // effect after a new sync.
  async function saveAndSync() {
    if (dirty && !(await save())) return
    setEditingSource(false)
    await sync.start()
  }

  const busy = saving || sync.running
  const marketLabel = shop
    ? [
        [flagEmoji(shop.selected_country), countryName(shop.selected_country)].filter(Boolean).join(' '),
        shop.selected_locale,
      ]
        .filter(Boolean)
        .join(' · ')
    : ''

  return (
    <div className="se">
      <header className="se-head">
        <div>
          <h1>Settings</h1>
          <p className="se-lede">
            Applies to this feed only: source, schedule, the ad account the feed is connected to, and the goals the figures are based on.
          </p>
        </div>
        <div className="se-actions">
          {status && <span className={`se-status${status.kind === 'error' ? ' neg' : ''}`}>{status.text}</span>}
          <button type="button" className="wl-btn-secondary" onClick={saveAndSync} disabled={busy}>
            {sync.running ? `Syncing… ${sync.status?.progress ?? 0}%` : shopDirty ? 'Save and sync' : 'Sync now'}
          </button>
          <button type="button" className="wl-btn-primary" onClick={save} disabled={busy || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {sync.running && sync.status && (
        <section className="card">
          <SyncProgressBar status={sync.status} variant="inline" />
        </section>
      )}

      <div className="se-grid">
        {/* ── Kilde ── */}
        <section className="card se-card">
          <div className="se-card-h">
            <div>
              <h3>Source</h3>
              <small>Where the products come from, and which market and language the feed fetches</small>
            </div>
            {source.type === 'shopify' && projectId && (
              <button type="button" className="link se-linkbtn" onClick={openSourceEditor} aria-expanded={editingSource}>
                {editingSource ? 'Close' : 'Edit'}
              </button>
            )}
          </div>
          <dl className="se-kv">
            <div>
              <dt>{source.type === 'feed_url' ? 'Feed URL' : 'Shop'}</dt>
              <dd title={source.address ?? undefined}>{source.address ?? '—'}</dd>
            </div>
            {source.type === 'shopify' && (
              <div>
                <dt>Market</dt>
                <dd>{marketLabel || <span className="neg">Not selected</span>}</dd>
              </div>
            )}
            <div>
              <dt>Language</dt>
              <dd>{shop ? languageName(shop.selected_locale) || shop.selected_locale : '—'}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd>{shop?.currency ?? '—'}</dd>
            </div>
            <div>
              <dt>Last synced</dt>
              <dd>{source.lastSyncedAt ? formatWhen(source.lastSyncedAt) : <span className="neg">Never</span>}</dd>
            </div>
          </dl>

          {editingSource && (
            <div className="se-edit">
              {!markets && !marketsError && <p className="se-muted">Fetching markets from Shopify…</p>}
              {marketsError && <p className="note warn">Could not fetch markets: {marketsError}</p>}
              {markets && fromFeedUrl && (
                <p className="note">The products come from a feed URL. Language and currency follow that feed, so there is no market to choose.</p>
              )}
              {markets && !fromFeedUrl && markets.length === 0 && (
                <p className="note">No markets found. The shop may not have Shopify Markets turned on.</p>
              )}
              {markets && markets.length > 0 && (
                <div className="se-markets" role="radiogroup" aria-label="Market">
                  {markets.map((m) => {
                    const on = m.id === shop?.selected_market_id
                    return (
                      <label key={m.id} className={`se-market${on ? ' on' : ''}`}>
                        <input type="radio" name="market" checked={on} onChange={() => selectMarket(m)} />
                        <span className="se-market-n">
                          <b>
                            {flagEmoji(m.countryCodes[0])} {m.name}
                          </b>
                          <small>
                            {m.currency}
                            {m.type === 'PRIMARY' ? ' · primary market' : ''}
                            {m.status !== 'ACTIVE' ? ' · draft' : ''}
                          </small>
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
              {locales.length > 0 && shop && (
                <div className="se-row se-row-tight">
                  <span>Language</span>
                  <select
                    className="se-sel"
                    value={shop.selected_locale}
                    onChange={(e) => setShop({ ...shop, selected_locale: e.target.value })}
                  >
                    {locales.map((l) => (
                      <option key={l.locale} value={l.locale}>
                        {languageName(l.locale) || l.name} ({l.locale}){l.primary ? ', default' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {shopDirty && (
                <p className="note warn">
                  A change of market or language takes effect after the next sync. Titles and descriptions are fetched in the chosen language.
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── Tidsplan ── */}
        <section className="card se-card">
          <div className="se-card-h">
            <div>
              <h3>Schedule</h3>
              <small>When the feed is built and when the figures are fetched from Google Ads. Danish time.</small>
            </div>
          </div>
          <div className="se-rows">
            <ScheduleRow
              label="Generate feed"
              hint="Fetches products and builds the feed"
              freq={feedFreq}
              time={feedTime}
              onFreq={setFeedFreq}
              onTime={setFeedTime}
              last={feedSchedule}
            />
            <ScheduleRow
              label="Fetch performance"
              hint={ads.customerId ? 'Fetches spend and conversions per product' : 'Choose a Google Ads account first'}
              freq={perfFreq}
              time={perfTime}
              onFreq={setPerfFreq}
              onTime={setPerfTime}
              last={perfSchedule}
              disabled={!ads.customerId}
            />
            <div className="se-row">
              <span className="se-row-l">
                Level
                <small>Also used by Labels</small>
              </span>
              <select
                className="se-sel"
                value={feedMode}
                onChange={(e) => setFeedMode(e.target.value as 'product' | 'variant')}
                aria-label="Level"
              >
                <option value="product">Per product (variants combined)</option>
                <option value="variant">Per variant</option>
              </select>
            </div>
          </div>
        </section>

        {/* ── Google Ads-konto ── */}
        <section className="card se-card">
          <div className="se-card-h">
            <div>
              <h3>Google Ads account</h3>
              <small>Connected per feed, because some have one account per language and others one account for several</small>
            </div>
            {ads.connectionError ? (
              <span className="pill warn">Connection failing</span>
            ) : ads.customerId ? (
              <span className="st">Connected</span>
            ) : (
              <span className="st st-off">Not connected</span>
            )}
          </div>

          {!ads.hasConnection ? (
            <div className="se-empty">
              <p>
                The feed has no Google Ads connection. Once it is approved, you choose the account here. We only read data and never
                change anything in the account.
              </p>
              <a href={`/api/google-ads/connect?feedId=${feedId}`} className="wl-btn-primary">
                Connect Google Ads
              </a>
            </div>
          ) : (
            <>
              {ads.connectionError && <p className="note warn">{ads.connectionError}</p>}
              <div className="se-rows">
                <div className="se-row">
                  <span className="se-row-l">
                    Account
                    {accountsState === 'loading' && <small>Fetching accounts…</small>}
                    {accountsState === 'error' && <small className="neg">Could not fetch accounts</small>}
                  </span>
                  <select
                    className="se-sel se-sel-wide"
                    value={customerId}
                    onFocus={loadAccounts}
                    onMouseDown={loadAccounts}
                    onChange={(e) => setCustomerId(e.target.value)}
                    aria-label="Google Ads account"
                  >
                    {!customerId && <option value="">Choose account…</option>}
                    {/* The saved account until the list arrives, so the field never reads empty. */}
                    {ads.customerId && !accounts?.some((a) => a.customerId === ads.customerId) && (
                      <option value={ads.customerId}>{ads.customerName || fmtId(ads.customerId)}</option>
                    )}
                    {(accounts ?? []).map((a) => (
                      <option key={a.customerId} value={a.customerId}>
                        {a.name || fmtId(a.customerId)} · {fmtId(a.customerId)} · {a.currencyCode}
                        {a.managerName ? ` (via ${a.managerName})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="se-row">
                  <span className="se-row-l">
                    Feed label
                    <small>Empty means the whole account</small>
                  </span>
                  <input
                    className="se-sel se-sel-wide"
                    value={feedLabel}
                    onChange={(e) => setFeedLabel(e.target.value)}
                    placeholder="e.g. DE"
                    aria-label="Feed label"
                  />
                </div>
              </div>
              <p className="se-foot">
                The filter decides which figures are fetched for the feed. Use it when one account covers several countries.
                {ads.lastSyncedAt && <> Last fetched {formatWhen(ads.lastSyncedAt)}.</>}
                {ads.lastSyncError && <span className="neg"> The last fetch failed: {ads.lastSyncError}</span>}{' '}
                <a href={`/api/google-ads/connect?feedId=${feedId}`} className="link">
                  Reconnect
                </a>
              </p>
            </>
          )}
        </section>

        {/* ── Konverteringsmål ── */}
        <section className="card se-card">
          <div className="se-card-h">
            <div>
              <h3>Conversion goals</h3>
              <small>The goals that revenue and profit are calculated from in Labels and Performance</small>
            </div>
          </div>
          {!ads.customerId ? (
            <p className="se-muted">Choose a Google Ads account first. The goals are chosen from the account’s conversion actions.</p>
          ) : actions.length === 0 ? (
            <p className="se-muted">
              There are no conversion actions yet. They appear once the figures have been fetched for the first time.
            </p>
          ) : (
            <div className="se-rows">
              <GoalRow label="Revenue" hint="Required for ROAS and Wasted spend" value={roas} onChange={setRoas} actions={actions} />
              <GoalRow label="Profit" hint="Gross profit, optional" value={poas} onChange={setPoas} actions={actions} optional />
            </div>
          )}
          {ads.customerId && actions.length > 0 && (
            <p className="se-foot">
              Several actions added together are chosen on{' '}
              <a href={`/feed/${feedId}/google-ads`} className="link">
                Performance
              </a>
              , where you can see how much each action reports.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function ScheduleRow({
  label,
  hint,
  freq,
  time,
  onFreq,
  onTime,
  last,
  disabled,
}: {
  label: string
  hint: string
  freq: AutoSyncFrequency
  time: string
  onFreq: (f: AutoSyncFrequency) => void
  onTime: (t: string) => void
  last: ScheduleState
  disabled?: boolean
}) {
  return (
    <div className="se-row">
      <span className="se-row-l">
        {label}
        <small>
          {hint}
          {last.lastRunAt && !disabled && (
            <>
              {' · '}
              {last.lastStatus === 'error' ? (
                <span className="neg" title={last.lastError ?? undefined}>
                  failed {formatWhen(last.lastRunAt)}
                </span>
              ) : (
                <>last {formatWhen(last.lastRunAt)}</>
              )}
            </>
          )}
        </small>
      </span>
      <span className="se-ctl">
        <select
          className="se-sel"
          value={freq}
          disabled={disabled}
          onChange={(e) => onFreq(e.target.value as AutoSyncFrequency)}
          aria-label={`${label}: how often`}
        >
          {AUTO_SYNC_FREQUENCIES.map((f) => (
            <option key={f} value={f}>
              {AUTO_SYNC_LABELS[f]}
            </option>
          ))}
        </select>
        {freq !== 'off' && (
          <input
            type="time"
            className="se-sel se-time"
            value={time}
            disabled={disabled}
            onChange={(e) => e.target.value && onTime(e.target.value)}
            aria-label={freq === 'daily' ? `${label}: time` : `${label}: starting at`}
          />
        )}
      </span>
    </div>
  )
}

function GoalRow({
  label,
  hint,
  value,
  onChange,
  actions,
  optional,
}: {
  label: string
  hint: string
  value: string[]
  onChange: (v: string[]) => void
  actions: Action[]
  optional?: boolean
}) {
  const joined = value.join(SEP)
  const known = new Set(actions.map((a) => a.name))
  return (
    <div className="se-row">
      <span className="se-row-l">
        {label}
        <small>{hint}</small>
      </span>
      <select
        className="se-sel se-sel-wide"
        value={joined}
        onChange={(e) => onChange(e.target.value ? e.target.value.split(SEP) : [])}
        aria-label={label}
      >
        <option value="">{optional ? 'None' : 'Choose action…'}</option>
        {/* A summed set chosen on Performance stays selectable as it is. */}
        {(value.length > 1 || (value.length === 1 && !known.has(value[0]))) && (
          <option value={joined}>{value.join(' + ')}</option>
        )}
        {actions.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
            {a.inWindow ? '' : ' (no data in the last 90 days)'}
          </option>
        ))}
      </select>
    </div>
  )
}
