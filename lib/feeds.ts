import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getAccountRole } from '@/lib/accounts'

export function adminDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export type FeedRow = {
  id: string
  // Who created the feed. Not an access check any more — see getOwnedFeed.
  user_id: string | null
  name: string
  description: string | null
  project_id: string | null
  created_at: string
  updated_at: string
}

// connection_status of a project's Shopify connection.
export type ProjectConnectionStatus = 'unverified' | 'connected' | 'error'

// A project row WITHOUT the encrypted token columns. Ownership checks and
// listings must never pull the secret material around — decryption happens
// only in lib/projectShopify.getProjectCredentials at call time.
export type ProjectRow = {
  id: string
  // Who created the project. Access goes through account_id (migration 052).
  user_id: string | null
  account_id: string
  name: string
  description: string | null
  shop_url: string | null
  // Where the project's products come from (migration 046).
  source_type: ProjectSourceType
  feed_url: string | null
  connection_status: ProjectConnectionStatus
  last_verified_at: string | null
  created_at: string
  updated_at: string
}

export type ProjectSourceType = 'shopify' | 'feed_url'

const PROJECT_PUBLIC_COLUMNS =
  'id, user_id, account_id, name, description, shop_url, source_type, feed_url, connection_status, last_verified_at, created_at, updated_at'

// A feed the user may work on, with the account it belongs to.
export type OwnedFeed = FeedRow & { account_id: string }

// Returns the feed if the user is a member of the account that owns the feed's
// project, otherwise null. Use this at every API route / server action entry
// that takes a feedId from the client.
//
// ("Owned" is kept in the name for continuity: since migration 052 a feed is
// owned by an account, and the user reaches it through membership.)
export async function getOwnedFeed(
  userId: string,
  feedId: string
): Promise<OwnedFeed | null> {
  const db = adminDb()
  const { data } = await db.from('feeds').select('*').eq('id', feedId).maybeSingle()
  const feed = (data as FeedRow | null) ?? null
  // feeds.project_id is NOT NULL; a feed without one has no owner to check.
  if (!feed?.project_id) return null

  const { data: project } = await db
    .from('projects')
    .select('account_id')
    .eq('id', feed.project_id)
    .maybeSingle<{ account_id: string }>()
  if (!project) return null

  if (!(await getAccountRole(db, userId, project.account_id))) return null
  return { ...feed, account_id: project.account_id }
}

// Returns the project if the user is a member of its account, otherwise null.
// Mirrors getOwnedFeed. Never selects the encrypted token columns.
export async function getOwnedProject(
  userId: string,
  projectId: string
): Promise<ProjectRow | null> {
  const db = adminDb()
  const { data } = await db
    .from('projects')
    .select(PROJECT_PUBLIC_COLUMNS)
    .eq('id', projectId)
    .maybeSingle()
  const project = (data as ProjectRow | null) ?? null
  if (!project) return null
  if (!(await getAccountRole(db, userId, project.account_id))) return null
  return project
}

// Picks the user's first (oldest) feed. Used for backwards-compat at
// /api/feed/[userId] which still needs to resolve to one feed.
export async function getFirstFeed(userId: string): Promise<FeedRow | null> {
  const db = adminDb()
  const { data } = await db
    .from('feeds')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as FeedRow | null) ?? null
}

// Deletes a feed's products (and their metafields) in small batches.
//
// Deleting a feed or project relies on ON DELETE CASCADE, which removes every
// product row in ONE statement. For a large catalog — a feed-URL project with
// ~28k products and ~110k metafields — that statement hits Supabase's statement
// timeout and the delete fails. Clearing the big tables first in batches leaves
// the cascade only the small per-feed tables (mappings, filters, cache, …).
export async function purgeFeedProducts(db: SupabaseClient, feedId: string): Promise<void> {
  for (;;) {
    const { data, error } = await db.from('products').select('id').eq('feed_id', feedId).limit(500)
    if (error) throw new Error(`purgeFeedProducts select: ${error.message}`)
    const ids = (data ?? []).map((r) => (r as { id: string }).id)
    if (ids.length === 0) return
    const mf = await db.from('product_metafields').delete().in('product_id', ids)
    if (mf.error) throw new Error(`purgeFeedProducts metafields: ${mf.error.message}`)
    const pr = await db.from('products').delete().in('id', ids)
    if (pr.error) throw new Error(`purgeFeedProducts products: ${pr.error.message}`)
  }
}
