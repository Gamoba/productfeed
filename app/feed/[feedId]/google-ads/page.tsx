import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getFeedSettings } from '@/lib/feedGoogleAds'
import { missingSetup } from '@/lib/googleAdsSync'
import {
  getAvailableActions,
  getComparison,
  getDailyTotals,
  getProductPerformance,
  getSyncedRange,
  resolveActions,
  type Window,
} from '@/lib/googleAdsAnalytics'
import { getProductMargins, marginCoverage, vatBasis } from '@/lib/variantCosts'
import { getReturnsForFeed } from '@/lib/returnsAnalytics'
import { getArchiveCoverage } from '@/lib/shopifyOrders'
import {
  getStockForFeed,
  stockAgeDays,
  stocksFromMultipleLocations,
} from '@/lib/inventoryAnalytics'
import { GoogleAdsClient } from './GoogleAdsClient'

const WINDOWS: Window[] = [7, 14, 30, 90, 180, 365]
const DEFAULT_WINDOW: Window = 30

export default async function GoogleAdsPage({
  params,
  searchParams,
}: {
  params: Promise<{ feedId: string }>
  searchParams: Promise<{
    days?: string
    ga_connected?: string
    ga_error?: string
    roas?: string | string[]
    poas?: string | string[]
  }>
}) {
  const { feedId } = await params
  const {
    days: daysParam,
    ga_connected,
    ga_error,
    roas: roasParam,
    poas: poasParam,
  } = await searchParams

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
  const setupIssues = missingSetup(settings)

  const hasConnection = !!settings?.connection_id
  const connected = !!settings?.customer_id

  if (!connected) {
    return (
      <GoogleAdsClient
        feedId={feedId}
        feedName={feed.name}
        days={days}
        windows={WINDOWS}
        connected={false}
        hasConnection={hasConnection}
        setupIssues={setupIssues}
        connectError={ga_error ?? null}
        justConnected={ga_connected === '1'}
        settings={
          settings
            ? {
                customerName: null,
                customerId: null,
                currency: settings.currency_code,
                roasActions: settings.roas_conversion_actions ?? [],
                poasActions: settings.poas_conversion_actions ?? [],
                lastSyncedAt: null,
                lastSyncError: null,
                feedLabel: settings.feed_label,
              }
            : null
        }
        availableActions={[]}
        activeActions={{ roas: [], poas: [] }}
        rows={[]}
        trend={[]}
        comparison={null}
        margins={{}}
        marginCoverage={{ withMargin: 0, products: 0 }}
        returns={{}}
        returnsContext={null}
        stock={{}}
        stockContext={null}
        vat={{ pricesIncludeVat: null, conversionValueIncludesVat: null, rate: null }}
        totals={null}
        from=""
        to=""
      />
    )
  }

  const actions = resolveActions({ roas: roasParam, poas: poasParam }, settings)

  const vat = vatBasis(settings ?? {})

  const synced = await getSyncedRange(db, feedId)

  const [{ rows, totals, from, to }, availableActions, margins, trend, comparison] =
    await Promise.all([
      getProductPerformance(db, feedId, days, actions),
      getAvailableActions(db, feedId, days),
      getProductMargins(db, feedId, vat),
      getDailyTotals(db, feedId, days, actions),
      getComparison(db, feedId, days, actions, synced.first),
    ])

  const marginByRef: Record<
    string,
    { margin: number | null; asEntered: number | null; coverage: number }
  > = {}
  for (const [ref, m] of margins) {
    marginByRef[ref] = { margin: m.margin, asEntered: m.marginAsEntered, coverage: m.coverage }
  }
  const coverage = marginCoverage(margins)

  const returns = await getReturnsForFeed(db, feedId, { from, to })
  const archive = returns.projectId ? await getArchiveCoverage(db, returns.projectId) : null

  // Stock is a property of the catalogue, not of the window being viewed, so it
  // is read once and does not move when someone switches between 7d and 90d.
  const stock = await getStockForFeed(db, feedId)

  const stockByRef: Record<
    string,
    {
      quantity: number | null
      coverage: number | null
      daysOfStock: number | null
      outOfStock: boolean
      variantsTotal: number
      variantsSellable: number
    }
  > = {}
  for (const [ref, s] of stock.byProduct) {
    stockByRef[ref] = {
      quantity: s.quantity,
      coverage: s.stockCoverage,
      daysOfStock: s.daysOfStock,
      outOfStock: s.outOfStock,
      variantsTotal: s.variantsTotal,
      variantsSellable: s.variantsSellable,
    }
  }

  const returnsByRef: Record<
    string,
    { returnRate: number | null; refundedInWindow: number; sampleUnits: number }
  > = {}
  for (const [ref, r] of returns.byProduct) {
    returnsByRef[ref] = {
      returnRate: r.returnRate,
      refundedInWindow: r.refundedInWindow,
      sampleUnits: r.sampleUnits,
    }
  }

  return (
    <GoogleAdsClient
      feedId={feedId}
      feedName={feed.name}
      days={days}
      windows={WINDOWS}
      connected
      hasConnection={hasConnection}
      setupIssues={setupIssues}
      connectError={ga_error ?? null}
      justConnected={ga_connected === '1'}
      settings={{
        customerName: settings?.customer_name ?? null,
        customerId: settings?.customer_id ?? null,
        currency: settings?.currency_code ?? null,
        roasActions: settings?.roas_conversion_actions ?? [],
        poasActions: settings?.poas_conversion_actions ?? [],
        lastSyncedAt: settings?.last_synced_at ?? null,
        lastSyncError: settings?.last_sync_error ?? null,
        feedLabel: settings?.feed_label ?? null,
      }}
      availableActions={availableActions}
      activeActions={actions}
      rows={rows}
      trend={trend.map((p) => ({
        date: p.date,
        cost: p.cost,
        revenue: p.roas_value,
        profit: p.poas_value,
        clicks: p.clicks,
        roas: p.roas,
      }))}
      // Only the fields the table actually compares are handed over. Sending
      // whole previous-period rows would double the page payload for a feature
      // that renders three numbers per product.
      comparison={{
        from: comparison.from,
        to: comparison.to,
        partial: comparison.partial,
        coveredDays: comparison.coveredDays,
        totals: {
          cost: comparison.totals.cost,
          clicks: comparison.totals.clicks,
          impressions: comparison.totals.impressions,
          roasValue: comparison.totals.roas_value,
          poasValue: comparison.totals.poas_value,
          roas: comparison.totals.roas,
          poas: comparison.totals.poas,
        },
        byProduct: Object.fromEntries(
          [...comparison.byProduct].map(([ref, p]) => [
            ref,
            { cost: p.cost, roasValue: p.roas_value, roas: p.roas, poas: p.poas },
          ])
        ),
      }}
      margins={marginByRef}
      marginCoverage={{ withMargin: coverage.withMargin, products: coverage.products }}
      returns={returnsByRef}
      returnsContext={{
        country: returns.country,
        cohortFrom: returns.cohortFrom,
        cohortTo: returns.cohortTo,
        overallRate: returns.overall.returnRate,
        overallSample: returns.overall.sampleUnits,
        refundedInWindow: returns.overall.refundedInWindow,
        returnedInWindow: returns.overall.windowReturnedValue,
        otherRefundedInWindow: returns.overall.windowOtherRefundedValue,
        archiveDepthDays: archive?.depthDays ?? null,
        archiveLastRunAt: archive?.lastRunAt ?? null,
        archiveHasGap: archive?.hasPermanentGap ?? true,
      }}
      stock={stockByRef}
      stockContext={{
        syncedAt: stock.syncedAt,
        ageDays: stockAgeDays(stock.syncedAt),
        velocityFrom: stock.velocityFrom,
        velocityTo: stock.velocityTo,
        velocityDays: stock.velocityDays,
        // Null means nobody has looked, which the UI states as such rather than
        // implying the quantity is specific to this feed's market.
        locationCount: stock.locations
          ? stock.locations.filter((l) => l.active && l.shipsInventory).length
          : null,
        multipleLocations: stocksFromMultipleLocations(stock.locations),
      }}
      vat={{
        pricesIncludeVat: settings?.prices_include_vat ?? null,
        conversionValueIncludesVat: settings?.conversion_value_includes_vat ?? null,
        rate: settings?.vat_rate ?? null,
      }}
      totals={totals}
      from={from}
      to={to}
    />
  )
}
