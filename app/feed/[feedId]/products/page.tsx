import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { ProductsClient } from '@/app/products/ProductsClient'

export default async function FeedProductsPage({
  params,
}: {
  params: Promise<{ feedId: string }>
}) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  // Ensure a feed_settings row exists so other pages (mapping, validation)
  // can rely on the invariant. Feed mode is managed exclusively from the
  // settings page now — it's not surfaced on the products page.
  const db = adminDb()
  const { data: settingsData } = await db
    .from('feed_settings')
    .select('feed_id')
    .eq('feed_id', feedId)
    .maybeSingle()

  if (!settingsData) {
    await db.from('feed_settings').insert({
      feed_id: feedId,
      user_id: user.id,
      feed_mode: 'product',
    })
  }

  const { data: syncRow } = await db.from('feeds').select('last_synced_at').eq('id', feedId).maybeSingle()

  return (
    <ProductsClient
      feedId={feedId}
      lastSynced={(syncRow?.last_synced_at as string | null) ?? null}
    />
  )
}
