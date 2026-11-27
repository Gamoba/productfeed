// Sign-in for the MCP endpoint.
//
// Supabase Auth is the OAuth 2.1 authorization server (enabled in the Supabase
// dashboard; consent page: app/oauth/consent). An MCP client such as Claude
// gets a normal Supabase access token for the user who approved it, and sends
// it as a Bearer token. We check it with Supabase and from then on the request
// is that user: every tool goes through the same membership checks as the UI
// (getOwnedFeed / getOwnedProject), so the assistant can never reach more than
// the person who connected it.

import type { User } from '@supabase/supabase-js'
import { adminDb } from '@/lib/feeds'

export const MCP_PATH = '/api/mcp'

export function authorizationServerUrl(): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/+$/, '')}/auth/v1`
}

export function mcpResourceMetadata(req: Request) {
  const origin = new URL(req.url).origin
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [authorizationServerUrl()],
    bearer_methods_supported: ['header'],
    resource_name: 'Kompara',
  }
}

export type McpCaller = {
  user: User
  /** OAuth client that holds the token (e.g. Claude), when the token says. */
  clientId: string | null
}

// The user behind a Bearer token, or null when it is missing or invalid.
export async function verifyMcpRequest(req: Request): Promise<McpCaller | null> {
  const header = req.headers.get('authorization') ?? ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const token = match[1].trim()

  const { data, error } = await adminDb().auth.getUser(token)
  if (error || !data.user) return null
  return { user: data.user, clientId: clientIdOf(token) }
}

// client_id claim of a Supabase OAuth access token. Only read for labelling
// (which assistant made a change); the token was already verified above.
function clientIdOf(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { client_id?: unknown }
    return typeof payload.client_id === 'string' ? payload.client_id : null
  } catch {
    return null
  }
}

// 401 that tells the client where to sign in (RFC 9728 §5.1).
export function unauthorized(req: Request): Response {
  const origin = new URL(req.url).origin
  return Response.json(
    { error: 'invalid_token', error_description: 'Sign in to Kompara to use this connector.' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
      },
    }
  )
}
