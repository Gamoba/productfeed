import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Agency › Connected companies. Placeholder from the prototype; what the page is for is
// still being decided. Reads no data.
export default async function ConnectedCompaniesPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  return (
    <PlaceholderPage
      title="Connected companies"
      lede="Companies the agency is connected to. Once a company is connected, all the agency's users get access to it."
      contents={["Connected companies with access and date", "Request access to a new company"]}
    />
  )
}
