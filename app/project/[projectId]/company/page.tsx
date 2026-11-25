import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › Company settings. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function CompanySettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
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
      title="Company settings"
      lede={`Plan og virksomhedsoplysninger for ${project.name}.`}
      contents={["Planen: hvor mange shops, feeds, SKU'er og brugere I kan have", "Virksomhed: navn, telefon og att.", "Adresse: adresse, postnummer, by og land"]}
      note="Plan og grænser er et åbent spørgsmål i guidelines (§8)."
    />
  )
}
