import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'


export const MIN_VELOCITY_UNITS = 20

export const DEFAULT_VELOCITY_DAYS = 90

// ── One variant's stock state ───────────────────────────────────────────────

export type VariantStock = {
  productRef: string
  variantRef: string
  title: string | null
  sku: string | null
  quantity: number | null
  tracked: boolean
  oversell: boolean
  sellable: boolean
  constrained: boolean
}

export function readVariantStock(
  productRef: string,
  v: Record<string, unknown>
): VariantStock | null {
  const variantRef = v.id === undefined || v.id === null ? '' : String(v.id)
  if (!variantRef) return null

  const tracked = (v.inventory_management ?? null) !== null
  const oversell = String(v.inventory_policy ?? 'deny') === 'continue'

  const rawQty = Number(v.inventory_quantity ?? 0)
  const quantity = tracked && Number.isFinite(rawQty) ? rawQty : null

  const rawTitle = v.title == null ? null : String(v.title)

  return {
    productRef,
    variantRef,
    title: rawTitle && rawTitle !== 'Default Title' ? rawTitle : null,
    sku: v.sku == null || String(v.sku) === '' ? null : String(v.sku),
    quantity,
    tracked,
    oversell,
    sellable: !tracked || oversell || (quantity ?? 0) > 0,
    constrained: tracked && !oversell,
  }
}

// ── Rolled up to whatever grain is being shown ──────────────────────────────

export type StockTotals = {
  variantsTotal: number
  variantsSellable: number
  variantsConstrained: number
  quantity: number | null
  unitsSold: number
}

export type StockDerived = {
  stockCoverage: number | null
  outOfStock: boolean
  unitsPerDay: number | null
  daysOfStock: number | null
  sampleUnits: number
}

export type StockRow = StockTotals &
  StockDerived & {
    productRef: string | null
    variantRef: string | null
    title: string | null
    sku: string | null
    sellable: boolean
  }

const EMPTY_TOTALS: StockTotals = {
  variantsTotal: 0,
  variantsSellable: 0,
  variantsConstrained: 0,
  quantity: null,
  unitsSold: 0,
}

function addTotals(a: StockTotals, b: StockTotals): StockTotals {
  return {
    variantsTotal: a.variantsTotal + b.variantsTotal,
    variantsSellable: a.variantsSellable + b.variantsSellable,
    variantsConstrained: a.variantsConstrained + b.variantsConstrained,
    quantity: a.quantity === null ? b.quantity : a.quantity + (b.quantity ?? 0),
    unitsSold: a.unitsSold + b.unitsSold,
  }
}

export function deriveStock(t: StockTotals, windowDays: number): StockDerived {
  const enough = t.unitsSold >= MIN_VELOCITY_UNITS
  const days = Math.max(1, windowDays)
  const unitsPerDay = enough ? t.unitsSold / days : null

  return {
    stockCoverage: t.variantsTotal > 0 ? t.variantsSellable / t.variantsTotal : null,
    outOfStock: t.variantsTotal > 0 && t.variantsSellable === 0,
    unitsPerDay,
    daysOfStock:
      t.quantity === null || unitsPerDay === null || unitsPerDay <= 0
        ? null
        : t.quantity / unitsPerDay,
    sampleUnits: t.unitsSold,
  }
}


type VelocityRow = {
  product_ref: string | null
  variant_ref: string | null
  units_sold: number
  orders: number
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export type ShopifyLocation = {
  id: string
  name: string
  active: boolean
  shipsInventory: boolean
}

export type StockResult = {
  byVariant: Map<string, StockRow>
  byProduct: Map<string, StockRow>
  syncedAt: string | null
  velocityFrom: string
  velocityTo: string
  velocityDays: number
  locations: ShopifyLocation[] | null
}

export const EMPTY_STOCK: StockResult = {
  byVariant: new Map(),
  byProduct: new Map(),
  syncedAt: null,
  velocityFrom: '',
  velocityTo: '',
  velocityDays: DEFAULT_VELOCITY_DAYS,
  locations: null,
}

export function stocksFromMultipleLocations(locations: ShopifyLocation[] | null): boolean {
  if (!locations) return false
  return locations.filter((l) => l.active && l.shipsInventory).length > 1
}

export async function getStockForFeed(
  db: SupabaseClient,
  feedId: string,
  opts: {
    velocityDays?: number
    productRef?: string
  } = {}
): Promise<StockResult> {
  const velocityDays = opts.velocityDays ?? DEFAULT_VELOCITY_DAYS

  let productQuery = db
    .from('products')
    .select('shopify_id, variants, synced_at')
    .eq('feed_id', feedId)
    .eq('status', 'active')
  if (opts.productRef) productQuery = productQuery.eq('shopify_id', opts.productRef)

  const [{ data: feedRow }, { data: productRows, error: productErr }] = await Promise.all([
    db.from('feeds').select('project_id').eq('id', feedId).maybeSingle(),
    productQuery,
  ])
  if (productErr) dbError('getStockForFeed products', productErr)

  const projectId = (feedRow as { project_id: string | null } | null)?.project_id ?? null

  const to = new Date()
  const from = new Date(to.getTime() - velocityDays * 86_400_000)
  const velocityFrom = from.toISOString().slice(0, 10)
  const velocityTo = to.toISOString().slice(0, 10)

  // ── Stock state, straight from the synced catalogue ──────────────────────
  const stockByVariant = new Map<string, VariantStock>()
  let syncedAt: string | null = null

  for (const row of (productRows ?? []) as {
    shopify_id: string
    variants: unknown
    synced_at: string | null
  }[]) {
    if (row.synced_at && (syncedAt === null || row.synced_at > syncedAt)) syncedAt = row.synced_at
    const variants = Array.isArray(row.variants) ? row.variants : []
    for (const v of variants) {
      if (!v || typeof v !== 'object') continue
      const stock = readVariantStock(row.shopify_id, v as Record<string, unknown>)
      if (stock) stockByVariant.set(stock.variantRef, stock)
    }
  }

  // ── Velocity, and the shop's locations ───────────────────────────────────
  const [velocityResult, locationResult] = await Promise.all([
    projectId
      ? db.rpc('shopify_velocity_variant_summary', {
          p_project_id: projectId,
          p_country: null,
          p_from: from.toISOString(),
          p_to: to.toISOString(),
        })
      : Promise.resolve({ data: [], error: null }),
    projectId
      ? db.from('projects').select('shopify_locations').eq('id', projectId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (velocityResult.error) dbError('getStockForFeed velocity', velocityResult.error)

  const soldByVariant = new Map<string, number>()
  for (const r of (velocityResult.data ?? []) as VelocityRow[]) {
    if (!r.variant_ref) continue
    soldByVariant.set(r.variant_ref, num(r.units_sold))
  }

  const rawLocations = (locationResult.data as { shopify_locations: unknown } | null)
    ?.shopify_locations
  const locations = Array.isArray(rawLocations) ? (rawLocations as ShopifyLocation[]) : null

  // ── Roll up ──────────────────────────────────────────────────────────────
  const byVariant = new Map<string, StockRow>()
  const productTotals = new Map<string, StockTotals>()

  for (const stock of stockByVariant.values()) {
    const sold = stock.constrained ? (soldByVariant.get(stock.variantRef) ?? 0) : 0

    const totals: StockTotals = {
      variantsTotal: 1,
      variantsSellable: stock.sellable ? 1 : 0,
      variantsConstrained: stock.constrained ? 1 : 0,
      quantity: stock.constrained ? (stock.quantity ?? 0) : null,
      unitsSold: sold,
    }

    byVariant.set(stock.variantRef, {
      productRef: stock.productRef,
      variantRef: stock.variantRef,
      title: stock.title,
      sku: stock.sku,
      sellable: stock.sellable,
      ...totals,
      ...deriveStock(totals, velocityDays),
    })

    productTotals.set(
      stock.productRef,
      addTotals(productTotals.get(stock.productRef) ?? EMPTY_TOTALS, totals)
    )
  }

  const byProduct = new Map<string, StockRow>()
  for (const [productRef, totals] of productTotals) {
    byProduct.set(productRef, {
      productRef,
      variantRef: null,
      title: null,
      sku: null,
      sellable: totals.variantsSellable > 0,
      ...totals,
      ...deriveStock(totals, velocityDays),
    })
  }

  return {
    byVariant,
    byProduct,
    syncedAt,
    velocityFrom,
    velocityTo,
    velocityDays,
    locations,
  }
}

// ── Freshness ───────────────────────────────────────────────────────────────

export function stockAgeDays(syncedAt: string | null, now = new Date()): number | null {
  if (!syncedAt) return null
  const then = new Date(syncedAt).getTime()
  if (!Number.isFinite(then)) return null
  return Math.max(0, Math.floor((now.getTime() - then) / 86_400_000))
}

export const STALE_STOCK_DAYS = 2
