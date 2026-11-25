import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Agency › Partner levels. Placeholder from the prototype; what the page is for is
// still being decided. Reads no data.
export default async function PartnerLevelsPage() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  return (
    <PlaceholderPage
      title="Partner levels"
      lede="Jo flere live-kunder bureauet har, jo højere kommission. Niveauerne følger kundeantallet automatisk."
      contents={["Partnerniveauerne (fx Bronze, Sølv) med kommission og krav til antal live-kunder", "Hvor bureauet står nu, og hvor mange kunder der mangler til næste niveau"]}
      note="Partnerniveauer bygger på en partneraftale, der ikke er på plads endnu."
    />
  )
}
