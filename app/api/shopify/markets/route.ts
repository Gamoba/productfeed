import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import { errorResponse } from '@/lib/errors'

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Markets come from the project's Shopify connection — projectId is required.
  const projectId = new URL(req.url).searchParams.get('projectId')
  if (!projectId) {
    return NextResponse.json({ error: 'projectId er påkrævet' }, { status: 400 })
  }
  const owned = await getOwnedProject(user.id, projectId)
  if (!owned) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // Feed-URL projects have no Shopify markets: language and currency are
  // whatever the source feed contains. `source` lets the UI say so.
  if (owned.source_type === 'feed_url') {
    return NextResponse.json({ markets: [], source: 'feed_url' })
  }

  try {
    const shopify = await createShopifyClientForProject(adminDb(), projectId)
    const markets = await shopify.fetchMarkets()
    return NextResponse.json({ markets })
  } catch (err) {
    return errorResponse(err, 'GET /api/shopify/markets')
  }
}
