'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ProjectConnectModal, type ConnectResult } from '@/app/components/ProjectConnectModal'
import { Icon } from '@/app/components/shell/icons'
import { formatNumber, formatWhen } from '@/lib/formatDa'
import './connections.css'

export type ConnectionsState = {
  projectId: string
  source: 'shopify' | 'feed_url'
  shopUrl: string | null
  feedUrl: string | null
  status: string
  lastVerifiedAt: string | null
  googleAds: { status: string; label: string | null } | null
  /** Feeds in this shop with a Google Ads account picked. */
  adsFeeds: number
  feeds: number
  /** Feed count per channel id. */
  channels: Record<string, number>
}

// The catalogue, from the prototype. Only a few entries exist in Kompara
// today; `live` below decides which. The rest is the build list, shown as
// "Planlagt" with no action, so nobody toggles something that does nothing.
const GROUPS: Record<string, string[]> = {
  'Shop systems': [
    'Shopify', 'Feed URL (XML)', 'WooCommerce', 'Umbraco', 'Magento', 'Prestashop', 'Shopware 5', 'Shopware 6',
    'BigCommerce', 'Lightspeed', 'Lightspeed E-Series', 'CCV Shop', 'Mijnwebwinkel', 'Oxid', 'Odoo', 'Shoptrader',
    'Squarespace', 'Afosto', 'Akeneo', 'ItsPerfect', 'Divide',
  ],
  'Google and ads': [
    'Google Shopping', 'Google Ads', 'Meta Catalog', 'Microsoft Ads', 'Daisycon', 'Google Analytics', 'Meta Ads',
    'Amazon Ads', 'Bol Ads', 'TikTok Shop (Europe)', 'TikTok Shop (US)',
  ],
  AI: ['Claude (Anthropic)', 'OpenAI', 'Google Gemini'],
  Marketplaces: [
    '2dehands Admarkt', '2ememain Admarkt', 'Allegro', 'Amazon', 'ANWB', 'Beslist', 'Bol', 'Boulanger', 'But',
    'Carrefour France', 'Carrefour Spain', 'Castorama', 'Cdiscount', 'Check24', 'Conforama', 'Conrad', 'Debenhams',
    'Decathlon', 'Douglas', 'eBay', 'ePrice', 'FNAC Darty Offers', 'Galaxus', 'Galeries Lafayette', 'Home24',
    'HomeDeco', 'Hornbach', 'Inno', 'Kaufland', 'Kruidvat', 'La Redoute', 'Leen Bakker', 'Leroy Merlin',
    'Maisons du Monde', 'ManoMano', 'Manor', 'Marktplaats Pro', 'Maxeda Brico', 'Maxeda Praxis', 'MediaMarkt',
    'Miravia', 'Obelink', 'Otto', 'PcComponentes', 'Rakuten', 'Shop Apotheke', 'Showroomprivé', 'Spartoo', 'Sprinter',
    'Teract', 'To Be Dressed', 'Veepee', 'vtwonen', 'Walmart', 'Winkelstraat.nl', 'Worten',
  ],
  'Files and API': ['SFTP Upload', 'Kompara API'],
}
const GROUP_NOTE: Record<string, string> = {
  'Shop systems': 'The shop has one source at a time: Shopify or a feed URL. Other shop systems can currently connect through their feed URL.',
  'Google and ads': "Channels are feeds you create under Feeds. Google Ads is linked per feed under the feed's Settings.",
  AI: "AI Titles and AI mapping use Kompara's own connection. There is no key to set up.",
}

type Tone = 'on' | 'bad' | 'avail' | 'planned'
type Tile = { name: string; group: string; tone: Tone; status: string; action?: { label: string; href?: string; onClick?: () => void } }

const CHANNEL_BY_NAME: Record<string, string> = {
  'Google Shopping': 'google_shopping',
  'Meta Catalog': 'meta_catalog',
  'Microsoft Ads': 'microsoft_ads',
  Daisycon: 'daisycon',
}
// Shop systems known to work through the feed-URL source (their Google
// Shopping export). Others may too, which the group note says.
const VIA_FEED_URL = new Set(['Umbraco'])

export function ConnectionsClient({ initial }: { initial: ConnectionsState }) {
  const [s, setS] = useState(initial)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [connect, setConnect] = useState<'shopify' | 'feed_url' | null>(null)
  const feedsHref = `/project/${s.projectId}`

  const shopifyOn = s.source === 'shopify' && s.status === 'connected'
  const feedUrlOn = s.source === 'feed_url' && s.status === 'connected'
  const sourceBad = s.status === 'error'

  const tiles: Tile[] = useMemo(() => {
    const t = (name: string, group: string): Tile => {
      if (name === 'Shopify') {
        if (s.source === 'shopify' && sourceBad) return { name, group, tone: 'bad', status: 'Connection failing', action: { label: 'Reconnect', onClick: () => setConnect('shopify') } }
        if (shopifyOn)
          return { name, group, tone: 'on', status: `${s.shopUrl ?? 'Connected'}${s.lastVerifiedAt ? ` · checked ${formatWhen(s.lastVerifiedAt)}` : ''}`, action: { label: 'Change token', onClick: () => setConnect('shopify') } }
        return { name, group, tone: 'avail', status: s.source === 'feed_url' ? 'Replaces feed URL as source' : 'Not connected', action: { label: 'Connect', onClick: () => setConnect('shopify') } }
      }
      if (name === 'Feed URL (XML)') {
        if (s.source === 'feed_url' && sourceBad) return { name, group, tone: 'bad', status: 'Feed cannot be fetched', action: { label: 'Fix', onClick: () => setConnect('feed_url') } }
        if (feedUrlOn) return { name, group, tone: 'on', status: hostOf(s.feedUrl) ?? 'Connected', action: { label: 'Change', onClick: () => setConnect('feed_url') } }
        return { name, group, tone: 'avail', status: s.source === 'shopify' && shopifyOn ? 'Replaces Shopify as source' : 'Google Shopping feed from another system', action: { label: 'Connect', onClick: () => setConnect('feed_url') } }
      }
      if (VIA_FEED_URL.has(name)) {
        return { name, group, tone: 'avail', status: 'Via feed URL', action: { label: 'Connect', onClick: () => setConnect('feed_url') } }
      }
      if (name === 'Google Ads') {
        if (s.googleAds?.status === 'error') return { name, group, tone: 'bad', status: 'Connection failing', action: { label: 'View feeds', href: `${feedsHref}/performance` } }
        if (s.googleAds)
          return {
            name,
            group,
            tone: 'on',
            status: `Linked on ${formatNumber(s.adsFeeds)} of ${formatNumber(s.feeds)} feeds`,
            action: { label: 'View feeds', href: `${feedsHref}/performance` },
          }
        return { name, group, tone: 'avail', status: 'Linked per feed under Settings', action: { label: 'Go to feeds', href: feedsHref } }
      }
      if (CHANNEL_BY_NAME[name]) {
        const n = s.channels[CHANNEL_BY_NAME[name]] ?? 0
        return n > 0
          ? { name, group, tone: 'on', status: `${formatNumber(n)} ${n === 1 ? 'feed' : 'feeds'}`, action: { label: 'View feeds', href: feedsHref } }
          : { name, group, tone: 'avail', status: 'As a feed channel', action: { label: 'Create feed', href: feedsHref } }
      }
      if (name === 'Claude (Anthropic)') return { name, group, tone: 'on', status: 'Built in' }
      return { name, group, tone: 'planned', status: 'Planned' }
    }
    return Object.entries(GROUPS).flatMap(([g, names]) => names.map((n) => t(n, g)))
  }, [s, shopifyOn, feedUrlOn, sourceBad, feedsHref])

  const needle = q.trim().toLowerCase()
  const shown = tiles.filter(
    (x) =>
      (cat === 'all' ||
        x.group === cat ||
        (cat === 'on' && (x.tone === 'on' || x.tone === 'bad')) ||
        (cat === 'avail' && x.tone !== 'planned')) &&
      (!needle || x.name.toLowerCase().includes(needle))
  )
  const chips: [string, string, number][] = [
    ['all', 'All', tiles.length],
    ['on', 'Connected', tiles.filter((x) => x.tone === 'on' || x.tone === 'bad').length],
    ['avail', 'Available now', tiles.filter((x) => x.tone !== 'planned').length],
    ...Object.keys(GROUPS).map((g): [string, string, number] => [g, g, GROUPS[g].length]),
  ]
  const groups = Object.keys(GROUPS).filter((g) => shown.some((x) => x.group === g))

  function handleConnected(r: ConnectResult) {
    setS((prev) => ({
      ...prev,
      source: r.source_type,
      status: r.connection_status,
      lastVerifiedAt: r.last_verified_at,
      shopUrl: r.source_type === 'shopify' ? r.shop : prev.shopUrl,
      feedUrl: r.source_type === 'feed_url' ? r.feedUrl : prev.feedUrl,
    }))
  }

  return (
    <div className="cn">
      <header className="cn-head">
        <div>
          <h1>Connections</h1>
          <p className="cn-lede">
            Everything the shop can connect to: shop systems, ad channels, marketplaces and AI. What works today can be
            connected here. The rest is planned.
          </p>
        </div>
      </header>

      <div className="cn-tools">
        <label className="cn-search">
          <Icon name="search" size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQ('')}
            placeholder="Search connections"
            aria-label="Search connections"
          />
        </label>
        <div className="cn-chips" role="group" aria-label="Filter">
          {chips.map(([id, label, n]) => (
            <button key={id} type="button" className="cn-chip" aria-pressed={cat === id} onClick={() => setCat(id)}>
              {label} <b className="num">{formatNumber(n)}</b>
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && (
        <section className="card cn-none">
          <p>No connections match. Clear the search or choose All.</p>
        </section>
      )}

      {groups.map((g) => {
        const list = shown.filter((x) => x.group === g)
        return (
          <section key={g} className="card">
            <div className="cn-card-h">
              <div>
                <h3>{g}</h3>
                {GROUP_NOTE[g] && <small>{GROUP_NOTE[g]}</small>}
              </div>
              <span className="cn-muted num">{formatNumber(list.length)}</span>
            </div>
            <div className="cn-grid">
              {list.map((x) => (
                <div key={x.name} className={`cn-tile ${x.tone}`}>
                  <span className="cn-av" aria-hidden="true">
                    {x.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2)}
                  </span>
                  <span className="cn-t">
                    <b>{x.name}</b>
                    <small className={x.tone === 'on' ? 'st' : x.tone === 'bad' ? 'neg' : undefined} title={x.status}>
                      {x.status}
                    </small>
                  </span>
                  {x.action &&
                    (x.action.href ? (
                      <Link href={x.action.href} className="link">
                        {x.action.label}
                      </Link>
                    ) : (
                      <button type="button" className="link cn-btn" onClick={x.action.onClick}>
                        {x.action.label}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </section>
        )
      })}

      <p className="cn-foot">
        Kompara only reads from Shopify and Google Ads and never changes anything there. Tokens are stored encrypted
        and never shown again.
      </p>

      {connect && (
        <ProjectConnectModal
          projectId={s.projectId}
          mode={s.status === 'connected' || s.status === 'error' ? 'rotate' : 'connect'}
          initialSource={connect}
          initialShopUrl={s.shopUrl}
          initialFeedUrl={s.feedUrl}
          onClose={() => setConnect(null)}
          onConnected={handleConnected}
        />
      )}
    </div>
  )
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
