import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { unauthorized, verifyMcpRequest } from '@/lib/mcp/auth'
import { createFeedFlowServer } from '@/lib/mcp/server'

// Kompara's MCP endpoint (Streamable HTTP). The address people add as a
// connector in Claude: https://<app>/api/mcp
//
// Stateless: each request is signed in from its Bearer token and gets a fresh
// server, so it runs on serverless without sessions. Without a valid token it
// answers 401 with a pointer to the sign-in metadata, which is what makes
// Claude open the "Connect Kompara" sign-in.

// start_sync fetches a whole catalogue; same ceiling as /api/shopify/sync.
export const maxDuration = 300

async function handle(req: Request): Promise<Response> {
  const caller = await verifyMcpRequest(req)
  if (!caller) return unauthorized(req)

  const server = createFeedFlowServer(caller)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  await server.connect(transport)
  return transport.handleRequest(req)
}

export { handle as GET, handle as POST, handle as DELETE }
