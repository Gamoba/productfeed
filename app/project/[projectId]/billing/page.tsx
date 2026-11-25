import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › Billing. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function BillingPage({ params }: { params: Promise<{ projectId: string }> }) {
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
      title="Billing"
      lede={`Payment and invoices for ${project.name}. Each customer has its own billing.`}
      contents={["Plan add-ons", "Payment method", "Invoice details", "Invoices with date, period and status"]}
    />
  )
}
