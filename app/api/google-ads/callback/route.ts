import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { saveConnection, getFeedSettings, saveFeedSettings } from '@/lib/feedGoogleAds'
import { exchangeCode, redirectUri, OAUTH_STATE_COOKIE, type OAuthState } from '@/lib/googleAdsOAuth'

// GET /api/google-ads/callback — Google redirects here after consent.
//
// Always ends in a redirect back to the feed's Performance page, with the
// outcome in the query string. Errors are NOT rendered here: this URL is
// registered with Google and reached by a browser navigation, so a JSON error
// body would be a dead end for the user.
function back(origin: string, feedId: string | null, params: Record<string, string>) {
  const path = feedId ? `/feed/${feedId}/google-ads` : '/'
  const url = new URL(path, origin)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(req: Request) {
  const origin = new URL(req.url).origin
  const jar = await cookies()

  let state: OAuthState | null = null
  try {
    const raw = jar.get(OAUTH_STATE_COOKIE)?.value
    state = raw ? (JSON.parse(raw) as OAuthState) : null
  } catch {
    state = null
  }
  // Single-use: clear it whatever happens, so a replayed callback can't reuse it.
  jar.delete(OAUTH_STATE_COOKIE)

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')
  const returnedState = url.searchParams.get('state')
  const feedId = state?.feedId ?? null

  if (error) {
    // access_denied is the user clicking cancel — not worth an alarming message.
    return back(origin, feedId, {
      ga_error: error === 'access_denied' ? 'Authorisation was cancelled.' : `Google: ${error}`,
    })
  }
  if (!state || !returnedState || returnedState !== state.nonce) {
    return back(origin, feedId, {
      ga_error: 'The authorisation could not be verified. Try again.',
    })
  }
  if (!code) {
    return back(origin, feedId, { ga_error: 'Google returned no code.' })
  }

  try {
    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return back(origin, feedId, { ga_error: 'Your session has expired. Sign in again.' })

    const feed = await getOwnedFeed(user.id, state.feedId)
    if (!feed) return back(origin, null, { ga_error: 'The feed was not found.' })

    const { refreshToken } = await exchangeCode(code, redirectUri(req.url))

    const db = adminDb()
    const connection = await saveConnection(db, user.id, {
      refreshToken,
      accountLabel: user.email ?? null,
      // login_customer_id is unknown until an account is chosen — the picker
      // resolves which manager reaches it and stores it then.
      loginCustomerId: null,
    })

    // Attach the connection to the feed so the picker knows which grant to use.
    // Deliberately does NOT set customer_id: nothing is queried until a human
    // has chosen the account and the two conversion actions.
    const existing = await getFeedSettings(db, state.feedId)
    await saveFeedSettings(db, state.feedId, {
      connection_id: connection.id,
      customer_id: existing?.customer_id ?? null,
    })

    return back(origin, state.feedId, { ga_connected: '1' })
  } catch (err) {
    console.error('[google-ads/callback]', err)
    return back(origin, feedId, {
      ga_error: err instanceof Error ? err.message : 'The connection failed.',
    })
  }
}
