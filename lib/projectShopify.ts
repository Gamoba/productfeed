// Resolves a project's Shopify credentials and builds a client from them.
// Server-side only — decrypted access tokens never leave this process.
//
// Every Shopify call resolves credentials from a project: there is no global
// env fallback. A project without a stored, decryptable token surfaces a clear
// error instead of silently using shared credentials.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createShopifyClient, type ShopifyClient, type ShopifyCredentials } from '@/lib/shopify'
import { decryptToken } from '@/lib/crypto'
import { AppError, dbError } from '@/lib/errors'

type ProjectCredsRow = {
  shop_url: string | null
  access_token_ciphertext: string | null
  access_token_iv: string | null
  access_token_tag: string | null
}

// Reads a project's stored Shopify credentials and decrypts the access token.
// Throws a clear error if the project is missing or has no connection yet.
export async function getProjectCredentials(
  db: SupabaseClient,
  projectId: string
): Promise<ShopifyCredentials> {
  const { data, error } = await db
    .from('projects')
    .select('shop_url, access_token_ciphertext, access_token_iv, access_token_tag')
    .eq('id', projectId)
    .maybeSingle<ProjectCredsRow>()

  if (error) dbError('getProjectCredentials', error)
  if (!data) throw new AppError('The project was not found', 404)
  if (
    !data.shop_url ||
    !data.access_token_ciphertext ||
    !data.access_token_iv ||
    !data.access_token_tag
  ) {
    throw new AppError('Projektet har ingen Shopify-forbindelse konfigureret endnu')
  }

  const accessToken = decryptToken({
    ciphertext: data.access_token_ciphertext,
    iv: data.access_token_iv,
    tag: data.access_token_tag,
  })
  return { shopUrl: data.shop_url, accessToken }
}

export async function createShopifyClientForProject(
  db: SupabaseClient,
  projectId: string
): Promise<ShopifyClient> {
  return createShopifyClient(await getProjectCredentials(db, projectId))
}
