import { randomBytes } from 'crypto'
import { AppError } from '@/lib/errors'
import { ADWORDS_SCOPE } from '@/lib/googleAds'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

export const OAUTH_STATE_COOKIE = 'ga_oauth_state'
export const OAUTH_STATE_MAX_AGE = 10 * 60

export function oauthClientConfig(): { id: string; secret: string } {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.CLIENT_ID
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.CLIENT_SECRET
  if (!id || !secret) {
    throw new AppError('The Google OAuth client is not configured in the environment.', 500)
  }
  return { id, secret }
}

export function redirectUri(requestUrl: string): string {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URI
  if (configured) return configured
  return new URL('/api/google-ads/callback', new URL(requestUrl).origin).toString()
}

export type OAuthState = { nonce: string; feedId: string }

export function newState(feedId: string): OAuthState {
  return { nonce: randomBytes(16).toString('base64url'), feedId }
}

export function buildAuthUrl(params: {
  clientId: string
  redirectUri: string
  nonce: string
  loginHint?: string | null
}): string {
  const q: Record<string, string> = {
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: ADWORDS_SCOPE,
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state: params.nonce,
  }
  if (params.loginHint) q.login_hint = params.loginHint

  return `${AUTH_URL}?${new URLSearchParams(q).toString().replace(/\+/g, '%20')}`
}

export type TokenExchange = { refreshToken: string; accessToken: string }

export async function exchangeCode(code: string, redirect: string): Promise<TokenExchange> {
  const { id, secret } = oauthClientConfig()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirect,
    }).toString(),
  })

  const json = (await res.json().catch(() => null)) as
    | { refresh_token?: string; access_token?: string; error?: string; error_description?: string }
    | null

  if (!res.ok || !json?.access_token) {
    console.error('[googleAdsOAuth] token exchange failed:', res.status, json?.error)
    throw new AppError('Google rejected the authorisation. Try connecting again.', 400)
  }

  if (!json.refresh_token) {
    throw new AppError(
      'Google did not return a refresh token. Remove the app’s access at ' +
        'myaccount.google.com/permissions and connect again.',
      400
    )
  }

  return { refreshToken: json.refresh_token, accessToken: json.access_token }
}
