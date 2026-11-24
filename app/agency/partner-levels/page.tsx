import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Agency › Partner levels. Placeholder from the prototype; what the page is for is
// still being decided. Reads no data.
export default async function PartnerLevelsPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <PlaceholderPage
      title="Partner levels"
      lede="The more live customers the agency has, the higher the commission. Levels follow the customer count automatically."
      contents={["The partner levels (e.g. Bronze, Silver) with commission and required number of live customers", "Where the agency stands now, and how many customers are needed for the next level"]}
      note="Partner levels depend on a partner agreement that is not in place yet."
    />
  )
}
