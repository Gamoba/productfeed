import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › Manage access. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function ManageAccessPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  return (
    <PlaceholderPage
      title="Manage access"
      lede={`Who can sign in to ${project.name}. This includes customers.`}
      contents={["Users on the shop with name, role and status", "The agency's users, the same list as Agency users"]}
    />
  )
}
