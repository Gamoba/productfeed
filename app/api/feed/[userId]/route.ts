import { adminDb, getFirstFeed } from '@/lib/feeds'
import { generateFeed } from '@/lib/feedGenerator'
import { feedServingBlocked } from '@/lib/entitlements'

const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours

function xmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  })
}

// Backwards-compat: pre-multi-feed clients (e.g. Google Merchant Center URLs
// already configured in production) still call /api/feed/[userId]. We map
// these to the user's first (oldest) feed.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params
  // Counted so the route can be retired once nothing calls it: search the
  // Vercel logs for "[legacy-feed-url]" (docs/billing-status.md).
  console.warn('[legacy-feed-url] hit for user', userId.slice(0, 8))

  const feed = await getFirstFeed(userId)
  if (!feed) {
    return xmlResponse(
      '<?xml version="1.0" encoding="UTF-8"?><error>No feeds found for user</error>',
      404
    )
  }

  const db = adminDb()

  // As /api/feed/generate: no usable plan, no feed (lib/entitlements).
  if (await feedServingBlocked(db, feed.id)) {
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?><error>This feed is paused: the account has no active plan</error>', 402)
  }

  const { data: cached } = await db
    .from('feed_cache')
    .select('xml_content, generated_at')
    .eq('feed_id', feed.id)
    .maybeSingle()

  if (cached) {
    const ageMs = Date.now() - new Date(cached.generated_at as string).getTime()
    if (ageMs < CACHE_TTL_MS) {
      return xmlResponse(cached.xml_content as string)
    }
  }

  try {
    const { xml, productCount } = await generateFeed(feed.id)

    await db.from('feed_cache').upsert(
      {
        feed_id: feed.id,
        xml_content: xml,
        generated_at: new Date().toISOString(),
        product_count: productCount,
      },
      { onConflict: 'feed_id' }
    )

    return xmlResponse(xml)
  } catch (err) {
    // Public endpoint — never echo internal error detail into the XML. Log it.
    console.error('[GET /api/feed/[userId]] feed generation failed:', err)
    return xmlResponse(
      '<?xml version="1.0" encoding="UTF-8"?><error>Feed generation failed</error>',
      500
    )
  }
}
