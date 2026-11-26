// Platform admins: Gamoba staff who invite agencies (MCCs), set commission
// rates, override kickbacks and mark payouts (migration 061, platform_admins).

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'

export async function isPlatformAdmin(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle()
  if (error) dbError('isPlatformAdmin', error)
  return !!data
}

export async function requirePlatformAdmin(db: SupabaseClient, userId: string): Promise<void> {
  if (!(await isPlatformAdmin(db, userId))) throw new AppError('Only Gamoba staff can do this', 403)
}

// platform_settings.default_commission_rate: the share of each paid invoice
// (excl. VAT) an agency earns on a client it referred, unless the agency has
// its own rate. 0–1, e.g. 0.2 = 20 %.
export async function getDefaultCommissionRate(db: SupabaseClient): Promise<number | null> {
  const { data, error } = await db
    .from('platform_settings')
    .select('value')
    .eq('key', 'default_commission_rate')
    .maybeSingle<{ value: unknown }>()
  if (error) dbError('getDefaultCommissionRate', error)
  const v = Number(data?.value)
  return data && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
}

export async function setDefaultCommissionRate(db: SupabaseClient, userId: string, rate: number): Promise<void> {
  await requirePlatformAdmin(db, userId)
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new AppError('The rate must be between 0 % and 100 %')
  const { error } = await db
    .from('platform_settings')
    .upsert({ key: 'default_commission_rate', value: rate, updated_by: userId, updated_at: new Date().toISOString() })
  if (error) dbError('setDefaultCommissionRate', error)
}
