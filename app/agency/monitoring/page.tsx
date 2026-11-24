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
      lede="Feed quality and critical errors across all customers."
      contents={["Feed quality per customer with number of feeds and a quality score", "Critical errors across customers"]}
    />
  )
}
