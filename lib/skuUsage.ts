// Reading the daily SKU usage, and the dates billing counts by (migration 066).
//
// One row per shop per day (shop_sku_usage) is written by lib/skuMeasure.ts,
// which is where the counting rule is described. An account's figure for a day
// is the sum over its shops, and a month's extras are billed on the highest
// daily total in that calendar month (lib/extraSkus.ts).
//
// No feed code is imported here, so pages can read usage without pulling in
// the feed generator.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'

// ── Dates ──────────────────────────────────────────────────────────

/** Today in UTC as YYYY-MM-DD; a measuring day is a UTC day. */
export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The first day of the month `date` is in (YYYY-MM-DD). */
export function monthStart(date: Date): string {
  return `${date.toISOString().slice(0, 7)}-01`
}

/** The first day of the month before the one `date` is in. */
export function previousMonthStart(date: Date): string {
  return monthStart(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1)))
}

/** The first day of the month after `monthFirstDay` (exclusive end of a month). */
export function nextMonthStart(monthFirstDay: string): string {
  const d = new Date(`${monthFirstDay}T00:00:00Z`)
  return monthStart(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
}

// ── Reading what was measured ─────────────────────────────────────────────

export type DailyTotal = { on: string; skus: number }

/** The account's daily totals (the sum over its shops) for a month. */
export async function accountDailyTotals(db: SupabaseClient, accountId: string, month: string): Promise<DailyTotal[]> {
  const { data, error } = await db
    .from('shop_sku_usage')
    .select('measured_on, sku_count')
    .eq('account_id', accountId)
    .gte('measured_on', month)
    .lt('measured_on', nextMonthStart(month))
  if (error) dbError('accountDailyTotals', error)
  const byDay = new Map<string, number>()
  for (const r of (data ?? []) as { measured_on: string; sku_count: number }[]) {
    byDay.set(r.measured_on, (byDay.get(r.measured_on) ?? 0) + r.sku_count)
  }
  return [...byDay.entries()].map(([on, skus]) => ({ on, skus })).sort((a, b) => a.on.localeCompare(b.on))
}

export type MonthPeak = { peak: number; days: number; latest: DailyTotal | null }

/** The highest daily total in a month, what the month's extras are billed on. */
export async function accountMonthPeak(db: SupabaseClient, accountId: string, month: string): Promise<MonthPeak> {
  const days = await accountDailyTotals(db, accountId, month)
  return {
    peak: days.reduce((n, d) => Math.max(n, d.skus), 0),
    days: days.length,
    latest: days.length ? days[days.length - 1] : null,
  }
}
