import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import {
  buildAuthUrl,
  newState,
  oauthClientConfig,
  redirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE,
} from '@/lib/googleAdsOAuth'
import { errorResponse } from '@/lib/errors'

// GET /api/google-ads/connect?feedId=… — starts the Google consent flow.
//
// The CSRF nonce and the originating feed are stored in an httpOnly cookie and
// verified on the callback. sameSite must be 'lax' rather than 'strict': the
// user returns here via a top-level redirect FROM Google, and a strict cookie
// would not be sent on that navigation, breaking every connect attempt.
export async function GET(req: Request) {
  try {
    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const url = new URL(req.url)
    const feedId = url.searchParams.get('feedId') ?? ''
    if (!feedId) return NextResponse.json({ error: 'feedId is required' }, { status: 400 })

    const feed = await getOwnedFeed(user.id, feedId)
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { id: clientId } = oauthClientConfig()
    const redirect = redirectUri(req.url)
    const state = newState(feedId)

    const res = NextResponse.redirect(
      buildAuthUrl({
        clientId,
        redirectUri: redirect,
        nonce: state.nonce,
        // Nudges Google toward the account already signed in here. Harmless if
        // it isn't the right one — the chooser still appears.
        loginHint: user.email ?? null,
      })
    )

    const jar = await cookies()
    jar.set(OAUTH_STATE_COOKIE, JSON.stringify(state), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: OAUTH_STATE_MAX_AGE,
    })

    return res
  } catch (err) {
    return errorResponse(err, 'GET /api/google-ads/connect')
  }
}
