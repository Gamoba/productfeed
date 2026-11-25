import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { getAccessibleProjectIds } from '@/lib/accounts'
import { errorResponse } from '@/lib/errors'
import { loadFeedList } from '@/lib/feedList'
import { logActivity } from '@/lib/activity'
import { channelOf } from '@/lib/channels'
import { channelAvailability, isChannelId } from '@/lib/channels'

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = adminDb()

  // Optional ?projectId scopes the list to one project (project home page).
  // Always limited to projects in the user's accounts, so the project filter
  // only narrows further.
  const projectId = new URL(req.url).searchParams.get('projectId')
  let projectIds: string[]
  try {
    projectIds = await getAccessibleProjectIds(db, user.id)
  } catch (err) {
    return errorResponse(err, 'GET /api/feeds projects')
  }
  if (projectId) projectIds = projectIds.filter((id) => id === projectId)
  if (projectIds.length === 0) return NextResponse.json({ feeds: [] })

  try {
    return NextResponse.json({ feeds: await loadFeedList(db, projectIds) })
  } catch (err) {
    return errorResponse(err, 'GET /api/feeds')
  }
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    name?: string
    description?: string
    project_id?: string
    // Which channel the feed is for (lib/channels.ts). Defaults to Google
    // Shopping, which is what every feed was before channels existed.
    channel?: string
    // The market's country, when known, to check the channel may be used there.
    country?: string | null
  }
  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const channel = body.channel ?? 'google_shopping'
  if (!isChannelId(channel)) {
    return NextResponse.json({ error: 'Ukendt kanal' }, { status: 400 })
  }
  const availability = channelAvailability(channel, body.country)
  if (!availability.available) {
    return NextResponse.json({ error: availability.reason }, { status: 400 })
  }

  // A feed hangs on a project — project_id is required and must be owned.
  if (!body.project_id) {
    return NextResponse.json({ error: 'project_id er påkrævet' }, { status: 400 })
  }
  const owned = await getOwnedProject(user.id, body.project_id)
  if (!owned) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  const projectId = owned.id

  const db = adminDb()
  const { data, error } = await db
    .from('feeds')
    .insert({
      user_id: user.id,
      name,
      description: body.description?.trim() || null,
      project_id: projectId,
      channel,
    })
    .select('id, name, description, project_id, channel, created_at, updated_at')
    .single()

  if (error) return errorResponse(error, 'POST /api/feeds')

  await logActivity(db, { user, feedId: data.id, area: 'Feed', action: 'Feed oprettet', after: `${channelOf(channel).label} · ${name}` })
  return NextResponse.json({ feed: data })
}
