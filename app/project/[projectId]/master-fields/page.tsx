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
      lede={"Create a rule once on the shop and use it in all feeds across countries and channels. Change a master field and every feed follows."}
      contents={["A list of the shop's master fields with name, rule, what they are used for, and how many feeds use them", "In Mapping, a field picks the Master field type and takes its rule from here", "A single country can still have its own rule"]}
      note="Master fields are postponed in the guidelines until feeds are in place."
    />
  )
}
