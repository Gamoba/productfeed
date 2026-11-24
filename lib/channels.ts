// Channels a feed can be built for, and where each one may be used.
//
// A feed is one channel in one market (docs/redesign/GUIDELINES.md §3). The
// market lives in shop_settings; the channel in feeds.channel (migration 053).
// The ids here must match the CHECK constraint in that migration.
//
// Output: every channel currently gets the same Google-format RSS 2.0 XML
// (lib/feedGenerator.ts). Meta and Microsoft accept that format. When a
// channel needs its own format or extra fields, add it to `format` and branch
// on it in the generator.

export const CHANNEL_IDS = ['google_shopping', 'meta_catalog', 'daisycon', 'microsoft_ads'] as const
export type ChannelId = (typeof CHANNEL_IDS)[number]

export type FeedFormat = 'google_rss'

export type Channel = {
  id: ChannelId
  label: string
  // One letter for the 22px channel icon.
  letter: string
  // CSS variable for the icon colour (app/globals.css).
  color: string
  format: FeedFormat
  description: string
}

export const CHANNELS: Record<ChannelId, Channel> = {
  google_shopping: {
    id: 'google_shopping',
    label: 'Google Shopping',
    letter: 'G',
    color: 'var(--ch-google)',
    format: 'google_rss',
    description: 'Merchant Center, Shopping campaigns and Performance Max.',
  },
  meta_catalog: {
    id: 'meta_catalog',
    label: 'Meta Catalog',
    letter: 'M',
    color: 'var(--ch-meta)',
    format: 'google_rss',
    description: 'Catalogue for ads on Facebook and Instagram.',
  },
  daisycon: {
    id: 'daisycon',
    label: 'Daisycon',
    letter: 'D',
    color: 'var(--ch-daisycon)',
    format: 'google_rss',
    description: 'Affiliate network and price comparison.',
  },
  microsoft_ads: {
    id: 'microsoft_ads',
    label: 'Microsoft Ads',
    letter: 'B',
    color: 'var(--ch-microsoft)',
    format: 'google_rss',
    description: 'Microsoft Merchant Center and Shopping on Bing.',
  },
}

export function isChannelId(v: unknown): v is ChannelId {
  return typeof v === 'string' && (CHANNEL_IDS as readonly string[]).includes(v)
}

export function channelOf(id: string | null | undefined): Channel {
  return isChannelId(id) ? CHANNELS[id] : CHANNELS.google_shopping
}

// ── Where each channel may be used ──────────────────────────────────────────
//
// Some countries allow more channels than others, e.g. registration
// requirements outside the EU. Each channel has one rule:
//
//   { only: [...] }    usable only in these countries
//   { except: [...] }  usable everywhere except these countries
//
// Countries are ISO 3166-1 alpha-2 codes. A reason is shown in the UI when a
// channel is not available. Every channel starts out allowed everywhere: the
// table is the place to add real restrictions as we learn them, not a list of
// guesses.

type CountryRule = { only: string[]; reason: string } | { except: string[]; reason: string }

export const CHANNEL_COUNTRY_RULES: Record<ChannelId, CountryRule> = {
  google_shopping: { except: [], reason: '' },
  meta_catalog: { except: [], reason: '' },
  daisycon: { except: [], reason: '' },
  microsoft_ads: { except: [], reason: '' },
}

export type Availability = { available: true } | { available: false; reason: string }

// Whether a channel may be used in a country. Unknown country (a feed-URL
// project has no Shopify market) is not blocked: there is nothing to check.
export function channelAvailability(channel: ChannelId, country: string | null | undefined): Availability {
  if (!country) return { available: true }
  const c = country.toUpperCase()
  const rule = CHANNEL_COUNTRY_RULES[channel]
  const allowed = 'only' in rule ? rule.only.includes(c) : !rule.except.includes(c)
  if (allowed) return { available: true }
  return {
    available: false,
    reason: rule.reason || `${CHANNELS[channel].label} cannot be used in ${c}.`,
  }
}
