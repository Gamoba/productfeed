import { authorizationServerUrl } from '@/lib/mcp/auth'

// Fallback for MCP clients that look for the authorization server's metadata
// on the resource's own origin (the older MCP auth spec) instead of following
// the protected-resource metadata. Passes Supabase Auth's metadata through
// unchanged. Read-only GET against our own Supabase project.
export async function GET() {
  const issuer = authorizationServerUrl()
  const { origin, pathname } = new URL(issuer)
  const res = await fetch(`${origin}/.well-known/oauth-authorization-server${pathname}`, {
    next: { revalidate: 300 },
  })
  if (!res.ok) return Response.json({ error: 'Authorization server metadata unavailable' }, { status: 502 })
  return Response.json(await res.json(), {
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
  })
}
