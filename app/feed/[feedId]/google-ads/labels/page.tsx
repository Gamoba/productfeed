import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getFeedSettings } from '@/lib/feedGoogleAds'
import { listLabels, listBuckets, type Bucket, type BucketLevel } from '@/lib/googleAdsBuckets'
import { LabelsClient, type LabelView, type PreviewTable, type PreviewRow } from './LabelsClient'

// How many entities to render per preview table. The point of that table is to
// sanity-check the rules, not to be a catalogue browser — a couple of hundred
// rows answers "did this land where I expected" without shipping the whole
// membership to the browser.
const PREVIEW_LIMIT = 200

export default async function LabelsPage({ params }: { params: Promise<{ feedId: string }> }) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const db = adminDb()
  const settings = await getFeedSettings(db, feedId)

  if (!settings?.customer_id) {
    return (
      <LabelsClient
        feedId={feedId}
        feedName={feed.name}
        connected={false}
        currency={null}
        roasActions={[]}
        poasActions={[]}
        labels={[]}
        tables={[]}
      />
    )
  }

  const [labels, buckets] = await Promise.all([listLabels(db, feedId), listBuckets(db, feedId)])

  // Membership as last committed, rather than a fresh evaluation that might
  // disagree with the labels products are actually carrying.
  const { data: memberRows } = await db
    .from('google_ads_bucket_members')
    .select('label_id, bucket_id, ref, level, product_ref')
    .eq('feed_id', feedId)

  const members = (memberRows ?? []) as {
    label_id: string
    bucket_id: string
    ref: string
    level: BucketLevel
    product_ref: string | null
  }[]

  const counts: Record<string, number> = {}
  for (const m of members) counts[m.bucket_id] = (counts[m.bucket_id] ?? 0) + 1

  // ── Is each label still telling the truth? ──
  //
  // Membership is only rewritten on request, so it can outlive both the data it
  // was computed from and the definition of "revenue" it used. A recompute
  // stamps the label's computed_at; a sync stamps last_synced_at and the
  // settings' updated_at with the same value. Only a settings edit pushes
  // updated_at past last_synced_at — which is what separates the two causes.
  const ms = (t: string | null | undefined) => (t ? Date.parse(t) : 0)
  const synced = ms(settings.last_synced_at)
  const touched = ms(settings.updated_at)

  const labelViews: LabelView[] = labels.map((l) => {
    const own = buckets.filter((b) => b.label_id === l.id)
    const computed = ms(l.computed_at)
    return {
      label: l,
      buckets: own,
      counts: Object.fromEntries(own.map((b) => [b.id, counts[b.id] ?? 0])),
      assigned: own.reduce((n, b) => n + (counts[b.id] ?? 0), 0),
      stale: {
        never: own.length > 0 && !computed,
        dataNewer: computed > 0 && synced > computed,
        settingsNewer: computed > 0 && touched > computed && touched > synced,
      },
    }
  })

  // ── Verification tables ──
  //
  // One row per entity, one column per label — the view you would actually
  // check before trusting any of this. Split BY LEVEL, because a product-level
  // label and a variant-level one do not describe the same rows: putting a
  // product id and a Merchant Center item id in one column would invite reading
  // across a row that has no shared subject.
  const bucketById = new Map(buckets.map((b) => [b.id, b]))
  const grouped = new Map<BucketLevel, { labelIds: string[]; rows: Map<string, PreviewRow> }>()

  for (const l of labels) {
    let g = grouped.get(l.level)
    if (!g) grouped.set(l.level, (g = { labelIds: [], rows: new Map() }))
    g.labelIds.push(l.id)
  }

  for (const m of members) {
    const g = grouped.get(m.level)
    if (!g) continue
    let row = g.rows.get(m.ref)
    if (!row) g.rows.set(m.ref, (row = { ref: m.ref, productRef: m.product_ref, title: null, cells: {} }))
    const b: Bucket | undefined = bucketById.get(m.bucket_id)
    if (b) row.cells[m.label_id] = { name: b.name, value: b.value }
  }

  const tables: PreviewTable[] = []
  for (const [level, g] of grouped) {
    if (!g.rows.size) continue
    const all = [...g.rows.values()]
    tables.push({
      level,
      labelIds: g.labelIds,
      rows: all.slice(0, PREVIEW_LIMIT),
      total: all.length,
    })
  }

  // Titles for the visible slice only.
  const productRefs = [
    ...new Set(tables.flatMap((t) => t.rows.map((r) => r.productRef).filter(Boolean))),
  ] as string[]
  const titles = new Map<string, string>()
  const CHUNK = 200
  for (let i = 0; i < productRefs.length; i += CHUNK) {
    const { data } = await db
      .from('products')
      .select('shopify_id, title')
      .eq('feed_id', feedId)
      .in('shopify_id', productRefs.slice(i, i + CHUNK))
    for (const p of (data ?? []) as { shopify_id: string; title: string | null }[]) {
      if (p.title) titles.set(p.shopify_id, p.title)
    }
  }
  for (const t of tables) {
    for (const r of t.rows) r.title = r.productRef ? (titles.get(r.productRef) ?? null) : null
  }

  return (
    <LabelsClient
      feedId={feedId}
      feedName={feed.name}
      connected
      currency={settings.currency_code}
      roasActions={settings.roas_conversion_actions ?? []}
      poasActions={settings.poas_conversion_actions ?? []}
      labels={labelViews}
      tables={tables}
    />
  )
}
