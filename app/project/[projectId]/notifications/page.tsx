import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › Notifications. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function NotificationsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  if (!(await getOwnedProject(user.id, projectId))) notFound()

  return (
    <PlaceholderPage
      title="Notifications"
      lede={"Hvilke mails shoppen sender, og hvem der får dem."}
      contents={["Hvad I vil have besked om: fejl i feeds, labels der skifter, og en ugentlig status", "Hvor ofte: kun fejl, fejl og information, eller en ugentlig opsummering", "Modtagere"]}
    />
  )
}
