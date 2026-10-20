import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getFeedConnectionSecret } from '@/lib/feedGoogleAds'
import { listReachableAccounts, listConversionActions } from '@/lib/googleAds'
import { errorResponse } from '@/lib/errors'

// GET — the ad accounts this feed's grant can reach, for the setup picker.
// With ?customer=<id> it returns that account's conversion actions instead, so
// the second setup step doesn't need its own route.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ feedId: string }> }
) {
  try {
    const { feedId } = await params

    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const feed = await getOwnedFeed(user.id, feedId)
    if (!feed) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const secret = await getFeedConnectionSecret(adminDb(), feedId)
    const url = new URL(req.url)
    const customer = url.searchParams.get('customer')
    const manager = url.searchParams.get('manager')

    if (customer) {
      const actions = await listConversionActions({
        refreshToken: secret.refreshToken,
        customerId: customer,
        loginCustomerId: manager || secret.loginCustomerId,
      })
      // Most-likely-useful first: purchase actions carrying real money, then the
      // rest. Ordering is a hint only — the choice stays explicit, because the
      // highest-value action in a real account is often a view_item tracker.
      actions.sort((a, b) => {
        const rank = (c: string) => (c === 'PURCHASE' ? 0 : 1)
        return rank(a.category) - rank(b.category) || a.name.localeCompare(b.name, 'da-DK')
      })
      return NextResponse.json({ actions })
    }

    return NextResponse.json({ accounts: await listReachableAccounts(secret.refreshToken) })
  } catch (err) {
    return errorResponse(err, 'GET /api/google-ads/[feedId]/accounts')
  }
}
