import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Agency › Connected companies. Placeholder from the prototype; what the page is for is
// still being decided. Reads no data.
export default async function ConnectedCompaniesPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <PlaceholderPage
      title="Connected companies"
      lede="Virksomheder, bureauet er koblet til. Når en virksomhed er koblet, får alle bureauets brugere adgang til den."
      contents={["Tilknyttede virksomheder med adgang og dato", "Anmod om adgang til en ny virksomhed"]}
    />
  )
}
