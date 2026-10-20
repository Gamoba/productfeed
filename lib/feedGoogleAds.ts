import type { SupabaseClient } from '@supabase/supabase-js'
import { createGoogleAdsClient, type GoogleAdsClient } from '@/lib/googleAds'
import { decryptToken, encryptToken } from '@/lib/crypto'
import { AppError, dbError } from '@/lib/errors'
import type { IdPattern } from '@/lib/googleAdsIds'

// ── Types ────────────────────────────────────────────────────────────────────

export type GoogleAdsConnectionStatus = 'unverified' | 'connected' | 'error'

export type GoogleAdsConnection = {
  id: string
  user_id: string
  account_label: string | null
  login_customer_id: string | null
  status: GoogleAdsConnectionStatus
  last_verified_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

const CONNECTION_PUBLIC_COLUMNS =
  'id, user_id, account_label, login_customer_id, status, last_verified_at, last_error, created_at, updated_at'

export type GoogleAdsFeedSettings = {
  id: string
  feed_id: string
  connection_id: string | null
  customer_id: string | null
  customer_name: string | null
  currency_code: string | null
  feed_label: string | null
  // Sets, summed — see ActionChoice in lib/googleAdsAnalytics.ts. Empty array,
  // never null, so "nothing chosen" has one representation.
  roas_conversion_actions: string[]
  poas_conversion_actions: string[]
  id_pattern: 'auto' | IdPattern
  id_pattern_country: string | null
  /**
   * Whether products.variants[].price carries VAT. NULL means nobody has said,
   * which is not the same as FALSE — see migration 040. Read by
   * getProductMargins to put price and cost on the same basis.
   */
  prices_include_vat: boolean | null
  /**
   * Whether the value Google reports for the chosen revenue action carries VAT.
   * Independent of prices_include_vat — a shop can hold net prices and still
   * report a gross order total — and NULL is again "unanswered", not FALSE.
   * Read with vat_rate to put reported revenue on the same basis as the net
   * margin before deriving break-even ROAS. See migration 043.
   */
  conversion_value_includes_vat: boolean | null
  /**
   * Percent (25, not 0.25). One rate serves both bases, because the rate is a
   * property of the market rather than of either basis. NULL when unknown or
   * when neither prices nor conversion values carry VAT.
   */
  vat_rate: number | null
  sync_window_days: number
  last_synced_at: string | null
  last_sync_error: string | null
  /**
   * Last write of any kind to this row. Read by the custom-label page to tell
   * that the settings moved after a label was computed — and since a sync
   * stamps last_synced_at and updated_at with the same value, anything later
   * than last_synced_at is a settings edit rather than a sync.
   *
   * Bucket configuration used to live here too (migration 035). It moved onto
   * google_ads_custom_labels in 039: level and window are properties of a
   * dimension, and forcing every dimension to share one made all but one of
   * them wrong.
   */
  updated_at: string | null
}

const SETTINGS_COLUMNS =
  'id, feed_id, connection_id, customer_id, customer_name, currency_code, feed_label, ' +
  'roas_conversion_actions, poas_conversion_actions, id_pattern, id_pattern_country, ' +
  'prices_include_vat, conversion_value_includes_vat, vat_rate, ' +
  'sync_window_days, last_synced_at, last_sync_error, updated_at'

// ── Connections ──────────────────────────────────────────────────────────────

export async function getConnection(
  db: SupabaseClient,
  userId: string
): Promise<GoogleAdsConnection | null> {
  const { data, error } = await db
    .from('google_ads_connections')
    .select(CONNECTION_PUBLIC_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) dbError('getConnection', error)
  return (data as GoogleAdsConnection | null) ?? null
}

export async function saveConnection(
  db: SupabaseClient,
  userId: string,
  params: { refreshToken: string; loginCustomerId?: string | null; accountLabel?: string | null }
): Promise<GoogleAdsConnection> {
  const enc = encryptToken(params.refreshToken)
  const now = new Date().toISOString()
  const existing = await getConnection(db, userId)

  const row = {
    user_id: userId,
    account_label: params.accountLabel ?? null,
    login_customer_id: params.loginCustomerId ? params.loginCustomerId.replace(/\D/g, '') : null,
    refresh_token_ciphertext: enc.ciphertext,
    refresh_token_iv: enc.iv,
    refresh_token_tag: enc.tag,
    status: 'connected' as const,
    last_verified_at: now,
    last_error: null,
    updated_at: now,
  }

  const q = existing
    ? db.from('google_ads_connections').update(row).eq('id', existing.id)
    : db.from('google_ads_connections').insert(row)

  const { data, error } = await q.select(CONNECTION_PUBLIC_COLUMNS).single()
  if (error) dbError('saveConnection', error)
  return data as GoogleAdsConnection
}

export async function markConnectionError(
  db: SupabaseClient,
  connectionId: string,
  message: string
): Promise<void> {
  await db
    .from('google_ads_connections')
    .update({ status: 'error', last_error: message, updated_at: new Date().toISOString() })
    .eq('id', connectionId)
}

// ── Feed settings ────────────────────────────────────────────────────────────

export async function getFeedSettings(
  db: SupabaseClient,
  feedId: string
): Promise<GoogleAdsFeedSettings | null> {
  const { data, error } = await db
    .from('google_ads_feed_settings')
    .select(SETTINGS_COLUMNS)
    .eq('feed_id', feedId)
    .maybeSingle()

  if (error) dbError('getFeedSettings', error)
  return (data as GoogleAdsFeedSettings | null) ?? null
}

export async function saveFeedSettings(
  db: SupabaseClient,
  feedId: string,
  patch: Partial<Omit<GoogleAdsFeedSettings, 'id' | 'feed_id'>>
): Promise<GoogleAdsFeedSettings> {
  const existing = await getFeedSettings(db, feedId)
  const row = { ...patch, feed_id: feedId, updated_at: new Date().toISOString() }

  const q = existing
    ? db.from('google_ads_feed_settings').update(row).eq('feed_id', feedId)
    : db.from('google_ads_feed_settings').insert(row)

  const { data, error } = await q.select(SETTINGS_COLUMNS).single()
  if (error) dbError('saveFeedSettings', error)
  return data as unknown as GoogleAdsFeedSettings
}


type TokenRow = {
  id: string
  login_customer_id: string | null
  refresh_token_ciphertext: string | null
  refresh_token_iv: string | null
  refresh_token_tag: string | null
}

export type ResolvedFeedGoogleAds = {
  client: GoogleAdsClient
  settings: GoogleAdsFeedSettings
  connectionId: string
}

export type ConnectionSecret = {
  connectionId: string
  refreshToken: string
  loginCustomerId: string | null
}

export async function getConnectionSecret(
  db: SupabaseClient,
  connectionId: string
): Promise<ConnectionSecret> {
  const { data, error } = await db
    .from('google_ads_connections')
    .select('id, login_customer_id, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag')
    .eq('id', connectionId)
    .maybeSingle<TokenRow>()

  if (error) dbError('getConnectionSecret', error)
  if (!data) throw new AppError('The Google Ads connection was not found.')
  if (!data.refresh_token_ciphertext || !data.refresh_token_iv || !data.refresh_token_tag) {
    throw new AppError('The Google Ads connection has no stored token. Create the connection again.')
  }

  try {
    return {
      connectionId: data.id,
      loginCustomerId: data.login_customer_id,
      refreshToken: decryptToken({
        ciphertext: data.refresh_token_ciphertext,
        iv: data.refresh_token_iv,
        tag: data.refresh_token_tag,
      }),
    }
  } catch (err) {
    console.error('[feedGoogleAds] token decrypt failed:', err)
    throw new AppError('The Google Ads token could not be read. Create the connection again.')
  }
}

export async function getFeedConnectionSecret(
  db: SupabaseClient,
  feedId: string
): Promise<ConnectionSecret> {
  const settings = await getFeedSettings(db, feedId)
  if (!settings?.connection_id) {
    throw new AppError('This feed has no Google Ads connection.')
  }
  return getConnectionSecret(db, settings.connection_id)
}

export async function createGoogleAdsClientForFeed(
  db: SupabaseClient,
  feedId: string
): Promise<ResolvedFeedGoogleAds> {
  const settings = await getFeedSettings(db, feedId)
  if (!settings) {
    throw new AppError('This feed is not linked to a Google Ads account yet.')
  }
  if (!settings.connection_id) {
    throw new AppError('This feed has no Google Ads connection.')
  }
  if (!settings.customer_id) {
    throw new AppError('No Google Ads account has been selected for this feed.')
  }

  const { data, error } = await db
    .from('google_ads_connections')
    .select('id, login_customer_id, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag')
    .eq('id', settings.connection_id)
    .maybeSingle<TokenRow>()

  if (error) dbError('createGoogleAdsClientForFeed', error)
  if (!data) throw new AppError('The Google Ads connection was not found.')

  if (!data.refresh_token_ciphertext || !data.refresh_token_iv || !data.refresh_token_tag) {
    throw new AppError('The Google Ads connection has no stored token. Create the connection again.')
  }

  let refreshToken: string
  try {
    refreshToken = decryptToken({
      ciphertext: data.refresh_token_ciphertext,
      iv: data.refresh_token_iv,
      tag: data.refresh_token_tag,
    })
  } catch (err) {
    console.error('[feedGoogleAds] token decrypt failed:', err)
    throw new AppError('The Google Ads token could not be read. Create the connection again.')
  }

  return {
    client: createGoogleAdsClient({
      refreshToken,
      customerId: settings.customer_id,
      loginCustomerId: data.login_customer_id,
    }),
    settings,
    connectionId: data.id,
  }
}
