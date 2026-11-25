import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › Manage access. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function ManageAccessPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  return (
    <PlaceholderPage
      title="Manage access"
      lede={`Hvem kan logge ind på ${project.name}. Gælder også kunder.`}
      contents={["Brugere på shoppen med navn, rolle og status", "Bureauets brugere, den samme liste som Agency users"]}
    />
  )
}
