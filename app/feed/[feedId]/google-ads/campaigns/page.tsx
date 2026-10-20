import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getFeedSettings } from '@/lib/feedGoogleAds'
import {
  getComparison,
  getSyncedRange,
  resolveActions,
  type Window,
} from '@/lib/googleAdsAnalytics'
import {
  findOverlaps,
  getCampaignPerformance,
  getProductCampaigns,
} from '@/lib/googleAdsCampaigns'
import { CampaignsClient } from './CampaignsClient'

const WINDOWS: Window[] = [7, 14, 30, 90, 180, 365]
const DEFAULT_WINDOW: Window = 30

export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ feedId: string }>
  searchParams: Promise<{
    days?: string
    roas?: string | string[]
    poas?: string | string[]
  }>
}) {
  const { feedId } = await params
  const { days: daysParam, roas: roasParam, poas: poasParam } = await searchParams

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const parsed = Number(daysParam)
  const days: Window = WINDOWS.includes(parsed as Window) ? (parsed as Window) : DEFAULT_WINDOW

  const db = adminDb()
  const settings = await getFeedSettings(db, feedId)
  const currency = settings?.currency_code ?? 'DKK'

  if (!settings?.customer_id) {
    return (
      <Shell feedName={feed.name}>
        <Empty
          title="Not connected to Google Ads"
          body="Campaign figures come from the same sync as the product table, so the feed needs a connection and at least one fetch first."
          action={{ href: `/feed/${feedId}/google-ads`, label: 'Go to Performance →' }}
        />
      </Shell>
    )
  }

  const actions = resolveActions({ roas: roasParam, poas: poasParam }, settings)

  const synced = await getSyncedRange(db, feedId)

  const [{ rows, from, to }, productCampaigns, comparison] = await Promise.all([
    getCampaignPerformance(db, feedId, days, actions),
    // The whole feed in one query: the campaign COUNT per product and the
    // overlap list are both folds over the same rows, so asking twice would be
    // two scans of the same table for one page.
    getProductCampaigns(db, feedId, days, null, actions),
    getComparison(db, feedId, days, actions, synced.first),
  ])

  // Previous-period campaign figures, for the same reason the product table has
  // them: a campaign's ROAS is a number, its direction is a finding.
  const previous = await getCampaignPerformance(db, feedId, days, actions, {
    from: comparison.from,
    to: comparison.to,
  })
  const previousById = Object.fromEntries(previous.rows.map((r) => [r.campaignId, r.cost]))
  const previousRoasById = Object.fromEntries(
    previous.rows.map((r) => [r.campaignId, r.roas])
  )

  const overlaps = findOverlaps(productCampaigns)

  // Titles for the overlap list. Only the products that actually appear in it
  // are looked up, which on a healthy account is a short list.
  const overlapRefs = overlaps.slice(0, 50).map((o) => o.productRef)
  const titles: Record<string, string> = {}
  if (overlapRefs.length) {
    const { data } = await db
      .from('products')
      .select('shopify_id, title')
      .eq('feed_id', feedId)
      .in('shopify_id', overlapRefs)
    for (const p of (data ?? []) as { shopify_id: string; title: string | null }[]) {
      if (p.title) titles[p.shopify_id] = p.title
    }
  }

  return (
    <Shell feedName={feed.name}>
      <CampaignsClient
        feedId={feedId}
        days={days}
        windows={WINDOWS}
        currency={currency}
        rows={rows}
        previousCost={previousById}
        previousRoas={previousRoasById}
        comparison={{
          from: comparison.from,
          to: comparison.to,
          partial: comparison.partial,
          coveredDays: comparison.coveredDays,
        }}
        overlaps={overlaps.slice(0, 50).map((o) => ({ ...o, title: titles[o.productRef] ?? null }))}
        overlapTotal={overlaps.length}
        activeActions={actions}
        feedLabel={settings.feed_label}
        from={from}
        to={to}
        lastSyncedAt={settings.last_synced_at}
      />
    </Shell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Shell({ feedName, children }: { feedName: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <main className="mx-auto px-6 py-9 space-y-6" style={{ maxWidth: '1800px' }}>
        <div className="wl-eyebrow truncate">{feedName}</div>
        {children}
      </main>
    </div>
  )
}

function Empty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: { href: string; label: string }
}) {
  return (
    <div className="wl-card" style={{ padding: '40px' }}>
      <div className="max-w-xl space-y-3">
        <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--ink)' }}>{title}</h2>
        <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink-secondary)' }}>{body}</p>
        {action && (
          <Link href={action.href} className="wl-btn-primary inline-block">
            {action.label}
          </Link>
        )}
      </div>
    </div>
  )
}
