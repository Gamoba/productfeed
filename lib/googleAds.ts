import { AppError } from '@/lib/errors'

export const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v24'

const API_ROOT = 'https://googleads.googleapis.com'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords'

const TOKEN_TTL_MARGIN_MS = 5 * 60 * 1000

export type GoogleAdsCredentials = {
  refreshToken: string
  customerId: string
  loginCustomerId?: string | null
}

export type GoogleAdsRow = Record<string, Record<string, unknown>>

export type GoogleAdsClient = {
  customerId: string
  query: (gaql: string) => Promise<GoogleAdsRow[]>
  queryCustomer: (customerId: string, gaql: string) => Promise<GoogleAdsRow[]>
}

export function normalizeCustomerId(id: string): string {
  return id.replace(/\D/g, '')
}

export function formatCustomerId(id: string): string {
  const d = normalizeCustomerId(id)
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d
}

/** cost_micros → currency units. Google returns micros as a string. */
export function microsToCurrency(micros: unknown): number {
  return Number(micros ?? 0) / 1_000_000
}

export function metricNumber(v: unknown): number {
  if (v === null || v === undefined) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** GAQL date literal (YYYY-MM-DD) in the account's local sense. */
export function gaqlDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}


type GoogleErrorBody = {
  error?: {
    message?: string
    status?: string
    details?: { errors?: { errorCode?: Record<string, string>; message?: string }[] }[]
  }
}

function describeError(status: number, body: unknown): { message: string; codes: string[] } {
  // searchStream returns a JSON ARRAY on success, and errors come back wrapped
  // the same way: [{ error: {...} }]. Reading `.error` off the array yields
  // undefined, which is how a perfectly explicit Google message ("field must be
  // present in SELECT clause") was being reported as a bare "HTTP 400 []".
  const b = (Array.isArray(body) ? body[0] : body) as GoogleErrorBody
  const codes: string[] = []
  const detailMessages: string[] = []
  for (const d of b?.error?.details ?? []) {
    for (const e of d.errors ?? []) {
      for (const v of Object.values(e.errorCode ?? {})) codes.push(String(v))
      if (e.message) detailMessages.push(e.message)
    }
  }
  // The per-error message is the specific one; error.message is the generic
  // "Request contains an invalid argument." wrapper.
  const msg = detailMessages.join(' ') || b?.error?.message || `HTTP ${status}`
  return { message: msg, codes }
}

function toAppError(status: number, body: unknown): AppError {
  const { message, codes } = describeError(status, body)
  const all = codes.join(',')

  if (all.includes('DEVELOPER_TOKEN_NOT_APPROVED')) {
    return new AppError(
      'The Google Ads developer token only has test access and cannot read live accounts.',
      403
    )
  }
  if (all.includes('USER_PERMISSION_DENIED') || all.includes('NOT_ADS_USER')) {
    return new AppError(
      'The connected Google user does not have access to this Google Ads account.',
      403
    )
  }
  if (all.includes('CUSTOMER_NOT_ENABLED') || all.includes('CUSTOMER_NOT_FOUND')) {
    return new AppError('The Google Ads account does not exist or is not active.', 404)
  }
  if (status === 401 || all.includes('AUTHENTICATION_ERROR')) {
    return new AppError('The Google Ads connection needs to be re-authorised.', 401)
  }
  if (status === 429 || all.includes('RESOURCE_EXHAUSTED') || all.includes('QUOTA_ERROR')) {
    return new AppError('The Google Ads quota is exhausted. Try again later.', 429)
  }
  // A malformed query is OUR bug, not the user's — but hiding Google's message
  // behind a generic error turns a five-second fix into a guessing game. The
  // text describes our own GAQL, not anything sensitive.
  if (all.includes('queryError') || codes.some((c) => c.includes('CLAUSE') || c.includes('FIELD'))) {
    console.error('[googleAds] GAQL error:', message, codes)
    return new AppError(`Google Ads rejected the query: ${message}`, 400)
  }

  console.error('[googleAds] unexpected API error:', status, message, codes)
  return new AppError('The Google Ads request failed.', 502)
}

// ── OAuth ────────────────────────────────────────────────────────────────────

function oauthClient(): { id: string; secret: string } {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.CLIENT_ID
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.CLIENT_SECRET
  if (!id || !secret) {
    throw new AppError('The Google OAuth client is not configured in the environment.', 500)
  }
  return { id, secret }
}

function developerToken(): string {
  const t = process.env.GOOGLE_DEVELOPER_TOKEN
  if (!t) throw new AppError('GOOGLE_DEVELOPER_TOKEN is missing from the environment.', 500)
  return t
}

// Access tokens are cached per refresh token for the process lifetime. A sync
// touching several accounts under one grant then costs one token exchange, not
// one per account.
const tokenCache = new Map<string, { token: string; expiresAt: number }>()

export async function getAccessToken(refreshToken: string): Promise<string> {
  const cached = tokenCache.get(refreshToken)
  if (cached && cached.expiresAt > Date.now()) return cached.token

  const { id, secret } = oauthClient()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  })

  const json = (await res.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error?: string }
    | null

  if (!res.ok || !json?.access_token) {

    if (json?.error === 'invalid_grant') {
      throw new AppError('The Google Ads connection has been revoked and must be created again.', 401)
    }
    console.error('[googleAds] token refresh failed:', res.status, json?.error)
    throw new AppError('Could not refresh Google Ads access.', 502)
  }

  const ttl = (json.expires_in ?? 3600) * 1000
  tokenCache.set(refreshToken, {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(0, ttl - TOKEN_TTL_MARGIN_MS),
  })
  return json.access_token
}

export function invalidateAccessToken(refreshToken: string): void {
  tokenCache.delete(refreshToken)
}

function assertSelectOnly(gaql: string): void {
  const normalized = gaql.trim().replace(/^\s*--.*$/gm, '').trim()
  if (!/^select\s/i.test(normalized)) {
    throw new AppError('Only SELECT queries are allowed against Google Ads.', 400)
  }
  if (/\b(mutate|insert|update|delete|create|remove)\b/i.test(normalized.split(/\bwhere\b/i)[0])) {
    throw new AppError('Only SELECT queries are allowed against Google Ads.', 400)
  }
}

const MAX_RETRIES = 3

function retryDelayMs(attempt: number): number {
  return 500 * 2 ** attempt // 500ms, 1s, 2s
}

async function searchStream(
  accessToken: string,
  customerId: string,
  loginCustomerId: string | null | undefined,
  gaql: string
): Promise<GoogleAdsRow[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken(),
    'Content-Type': 'application/json',
  }
  if (loginCustomerId) headers['login-customer-id'] = normalizeCustomerId(loginCustomerId)

  const url = `${API_ROOT}/${GOOGLE_ADS_API_VERSION}/customers/${normalizeCustomerId(
    customerId
  )}/googleAds:searchStream`

  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: gaql }) })

    if (res.ok) {
      const json = await res.json()
      const chunks = (Array.isArray(json) ? json : [json]) as { results?: GoogleAdsRow[] }[]
      return chunks.flatMap((c) => c.results ?? [])
    }

    const body = await res.json().catch(() => null)

    const transient = res.status === 429 || res.status >= 500
    if (!transient || attempt === MAX_RETRIES - 1) throw toAppError(res.status, body)

    lastError = body
    await new Promise((r) => setTimeout(r, retryDelayMs(attempt)))
  }

  throw toAppError(503, lastError)
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createGoogleAdsClient(creds: GoogleAdsCredentials): GoogleAdsClient {
  const customerId = normalizeCustomerId(creds.customerId)

  const run = async (target: string, gaql: string): Promise<GoogleAdsRow[]> => {
    assertSelectOnly(gaql)
    const token = await getAccessToken(creds.refreshToken)
    try {
      return await searchStream(token, target, creds.loginCustomerId, gaql)
    } catch (err) {
      // One retry after dropping a possibly-stale cached token.
      if (err instanceof AppError && err.status === 401) {
        invalidateAccessToken(creds.refreshToken)
        const fresh = await getAccessToken(creds.refreshToken)
        return searchStream(fresh, target, creds.loginCustomerId, gaql)
      }
      throw err
    }
  }

  return {
    customerId,
    query: (gaql) => run(customerId, gaql),
    queryCustomer: (target, gaql) => run(target, gaql),
  }
}

// ── Account discovery ────────────────────────────────────────────────────────

export type AccessibleAccount = {
  customerId: string
  name: string
  isManager: boolean
  currencyCode: string
  timeZone: string
}

export async function listClientAccounts(
  creds: GoogleAdsCredentials,
  managerCustomerId: string
): Promise<AccessibleAccount[]> {
  const client = createGoogleAdsClient({ ...creds, customerId: managerCustomerId })
  const rows = await client.queryCustomer(
    normalizeCustomerId(managerCustomerId),
    `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager,
            customer_client.currency_code, customer_client.time_zone
     FROM customer_client
     WHERE customer_client.status = 'ENABLED'`
  )

  return rows
    .map((r) => ({
      customerId: String(r.customerClient?.id ?? ''),
      name: String(r.customerClient?.descriptiveName ?? ''),
      isManager: r.customerClient?.manager === true,
      currencyCode: String(r.customerClient?.currencyCode ?? ''),
      timeZone: String(r.customerClient?.timeZone ?? ''),
    }))
    .filter((a) => a.customerId && !a.isManager)
    .sort((a, b) => a.name.localeCompare(b.name, 'da-DK'))
}

/** Customer ids the authorising user can reach directly (owned or managed). */
export async function listAccessibleCustomerIds(refreshToken: string): Promise<string[]> {
  const token = await getAccessToken(refreshToken)
  const res = await fetch(
    `${API_ROOT}/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`,
    { headers: headersFor(token) }
  )
  const json = await res.json().catch(() => null)
  if (!res.ok) throw toAppError(res.status, json)
  const names = (json as { resourceNames?: string[] })?.resourceNames ?? []
  return names.map((n) => n.split('/').pop() ?? '').filter(Boolean)
}

function headersFor(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'developer-token': developerToken(),
    'Content-Type': 'application/json',
  }
}

export type ReachableAccount = AccessibleAccount & {
  /** The manager to send as login-customer-id, or null when owned directly. */
  viaManager: string | null
  managerName: string | null
}

export async function listReachableAccounts(refreshToken: string): Promise<ReachableAccount[]> {
  const ids = await listAccessibleCustomerIds(refreshToken)
  const found = new Map<string, ReachableAccount>()

  for (const id of ids) {
    let self: AccessibleAccount | null = null
    try {
      const client = createGoogleAdsClient({ refreshToken, customerId: id, loginCustomerId: id })
      const rows = await client.query(
        `SELECT customer.id, customer.descriptive_name, customer.manager,
                customer.currency_code, customer.time_zone
         FROM customer LIMIT 1`
      )
      const c = rows[0]?.customer
      if (!c) continue
      self = {
        customerId: String(c.id ?? id),
        name: String(c.descriptiveName ?? ''),
        isManager: c.manager === true,
        currencyCode: String(c.currencyCode ?? ''),
        timeZone: String(c.timeZone ?? ''),
      }
    } catch {
      continue
    }

    if (!self.isManager) {
      found.set(self.customerId, { ...self, viaManager: null, managerName: null })
      continue
    }

    try {
      for (const child of await listClientAccounts(
        { refreshToken, customerId: self.customerId, loginCustomerId: self.customerId },
        self.customerId
      )) {
        if (!found.has(child.customerId)) {
          found.set(child.customerId, {
            ...child,
            viaManager: self.customerId,
            managerName: self.name,
          })
        }
      }
    } catch {
      continue
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'da-DK'))
}

export type ConversionActionInfo = {
  name: string
  category: string
  primaryForGoal: boolean
}

export async function listConversionActions(
  creds: GoogleAdsCredentials
): Promise<ConversionActionInfo[]> {
  const client = createGoogleAdsClient(creds)
  const rows = await client.query(
    `SELECT conversion_action.name, conversion_action.category,
            conversion_action.primary_for_goal
     FROM conversion_action
     WHERE conversion_action.status = 'ENABLED'`
  )
  return rows.map((r) => ({
    name: String(r.conversionAction?.name ?? ''),
    category: String(r.conversionAction?.category ?? ''),
    // Absent means true in the API's default-value encoding.
    primaryForGoal: r.conversionAction?.primaryForGoal !== false,
  }))
}
