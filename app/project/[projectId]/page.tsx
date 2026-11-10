import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { getOwnedProject } from '@/lib/feeds'
import { ProjectHomeClient } from './ProjectHomeClient'

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  return (
    <ProjectHomeClient
      projectId={project.id}
      projectName={project.name}
      shopUrl={project.shop_url}
      sourceType={project.source_type ?? 'shopify'}
      feedUrl={project.feed_url}
      connectionStatus={project.connection_status}
      lastVerifiedAt={project.last_verified_at}
    />
  )
}
