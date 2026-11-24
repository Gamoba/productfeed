import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Agency › Monitoring. Placeholder from the prototype; what the page is for is
// still being decided. Reads no data.
export default async function MonitoringPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <PlaceholderPage
      title="Monitoring"
      lede="Feed-kvalitet og kritiske fejl på tværs af alle kunder."
      contents={["Feed-kvalitet pr. kunde med antal feeds og en kvalitetsscore", "Kritiske fejl på tværs af kunderne"]}
    />
  )
}
