import { mcpResourceMetadata } from '@/lib/mcp/auth'

// OAuth protected-resource metadata (RFC 9728) for the MCP endpoint. Claude
// reads it to learn that FeedFlow's MCP server is signed into via Supabase
// Auth. Served both at the root and at the path-suffixed form
// (/.well-known/oauth-protected-resource/api/mcp) that newer clients try first.
export function GET(req: Request) {
  return Response.json(mcpResourceMetadata(req), {
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
  })
}
