import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { PlaceholderPage } from '@/app/components/PlaceholderPage'

// Shop › Master fields. Placeholder from the prototype; what the page is for is
// still being decided. Only checks access, reads nothing else.
export default async function MasterFieldsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  if (!(await getOwnedProject(user.id, projectId))) notFound()

  return (
    <PlaceholderPage
      title="Master fields"
      lede={"Lav en regel én gang på shoppen, og brug den i alle feeds på tværs af lande og kanaler. Retter du et master field, følger alle feeds med."}
      contents={["En liste over shoppens master fields med navn, regel, hvad de bruges til, og hvor mange feeds der bruger dem", "I Mapping vælger et felt typen Master field og henter reglen herfra", "Et enkelt land kan stadig få sin egen regel"]}
      note="Master fields er udskudt i guidelines, indtil feeds er på plads."
    />
  )
}
