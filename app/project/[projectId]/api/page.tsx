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
      lede={"To måder at koble andre systemer på shoppen: API til jeres egne systemer og MCP til AI-assistenter."}
      contents={["API: shop-id, aktive tokens (op til to, vises kun én gang) og et link til dokumentationen", "MCP: en adresse at indsætte i en AI-assistent og en kontakt, der slår MCP til for shoppen", "Hvad assistenten må: læse, foreslå ændringer, og gemme uden godkendelse (slået fra som standard)"]}
    />
  )
}
