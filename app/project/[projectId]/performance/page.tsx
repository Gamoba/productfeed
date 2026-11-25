import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { getShopPerformance } from '@/lib/shopPerformance'
import { ShopPerformanceView, WINDOWS } from './ShopPerformanceView'

const DEFAULT_DAYS = 30

// Shop › General performance. The shop's Google Ads numbers across all its
// feeds; each feed's own numbers are one click away on its Performance page.
export default async function ShopPerformancePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ days?: string }>
}) {
  const { projectId } = await params
  const { days: daysParam } = await searchParams

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  const parsed = Number(daysParam)
  const days = (WINDOWS as readonly number[]).includes(parsed) ? parsed : DEFAULT_DAYS
  const perf = await getShopPerformance(adminDb(), projectId, days)

  return <ShopPerformanceView projectId={projectId} perf={perf} />
}
