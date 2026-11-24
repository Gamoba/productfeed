import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › API / MCP. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function ApiMcpPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  if (!(await getOwnedProject(user.id, projectId))) notFound()

  return (
    <PlaceholderPage
      title="API / MCP"
      lede={"Two ways to connect other systems to the shop: API for your own systems and MCP for AI assistants."}
      contents={["API: shop ID, active tokens (up to two, shown only once) and a link to the documentation", "MCP: an address to paste into an AI assistant and a switch that turns on MCP for the shop", "What the assistant may do: read, suggest changes, and save without approval (off by default)"]}
    />
  )
}
