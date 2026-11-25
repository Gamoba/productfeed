import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import { errorResponse } from '@/lib/errors'

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)

  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Diagnostic products fetch — credentials come from a project, so projectId
  // is required (no global env fallback).
  const projectId = new URL(req.url).searchParams.get('projectId')
  if (!projectId) {
    return Response.json({ error: 'projectId is required' }, { status: 400 })
  }
  const owned = await getOwnedProject(user.id, projectId)
  if (!owned) {
    return Response.json({ error: 'Project not found' }, { status: 404 })
  }

  try {
    const shopify = await createShopifyClientForProject(adminDb(), projectId)
    const data = await shopify.fetchProductsWithAllData()
    return Response.json(data)
  } catch (err) {
    return errorResponse(err, 'GET /api/shopify/products')
  }
}
