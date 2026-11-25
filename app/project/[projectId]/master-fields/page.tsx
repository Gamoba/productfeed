import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { loadMasterFields, masterUsage } from '@/lib/masterFields'
import { channelOf } from '@/lib/channels'
import { MasterFieldsClient } from './MasterFieldsClient'

// Shop › Master fields: rules set up once on the shop and used by its feeds
// (lib/masterFields, lib/mappingEval). Each feed's mappings are loaded too:
// they give the "Used in" counts and the preview's `feed:` references.
export default async function MasterFieldsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  if (!(await getOwnedProject(user.id, projectId))) notFound()

  const db = adminDb()
  const [masters, { data: feedRows }] = await Promise.all([
    loadMasterFields(db, projectId),
    db.from('feeds').select('*').eq('project_id', projectId).order('created_at'),
  ])
  const feeds = (feedRows ?? []) as { id: string; name: string; channel?: string | null }[]
  const ids = feeds.map((f) => f.id)
  const [{ data: mappingRows }, { data: settingRows }] = ids.length
    ? await Promise.all([
        db.from('feed_mappings').select('feed_id, google_field, mapping_type, config').in('feed_id', ids),
        db.from('feed_settings').select('feed_id, feed_mode').in('feed_id', ids),
      ])
    : [{ data: [] }, { data: [] }]
  const mappings = (mappingRows ?? []) as { feed_id: string; google_field: string; mapping_type: string; config: Record<string, unknown> }[]
  const modes = new Map(((settingRows ?? []) as { feed_id: string; feed_mode: string | null }[]).map((r) => [r.feed_id, r.feed_mode]))
  const usage = masterUsage(mappings)

  return (
    <MasterFieldsClient
      projectId={projectId}
      initial={masters.map((m) => ({
        key: m.key,
        name: m.name,
        description: m.description,
        mapping_type: m.mapping_type,
        config: m.config,
        usedBy: [...(usage.get(m.key) ?? [])],
      }))}
      feeds={feeds.map((f) => ({
        id: f.id,
        label: `${channelOf(f.channel).label} · ${f.name}`,
        feedMode: modes.get(f.id) === 'variant' ? 'variant' : 'product',
        mappings: mappings
          .filter((m) => m.feed_id === f.id && m.mapping_type)
          .map((m) => ({ google_field: m.google_field, mapping_type: m.mapping_type, config: m.config ?? {} })),
      }))}
    />
  )
}
