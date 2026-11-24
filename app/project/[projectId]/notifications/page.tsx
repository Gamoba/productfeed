import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › Notifications. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function NotificationsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  if (!(await getOwnedProject(user.id, projectId))) notFound()

  return (
    <PlaceholderPage
      title="Notifications"
      lede={"Which emails the shop sends, and who receives them."}
      contents={["What you want to hear about: feed errors, labels that change, and a weekly status", "How often: errors only, errors and information, or a weekly summary", "Recipients"]}
    />
  )
}
