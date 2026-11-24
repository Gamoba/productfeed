// Feed configuration changes, shared by the UI's server actions and the MCP
// tools (lib/mcp). Callers check access first (getOwnedFeed); these functions
// only do the change, log it to the Activity log and keep the feed cache in
// step. `via` marks changes made through an assistant ("Theis via Claude").
//
// Nothing here talks to Shopify: it is FeedFlow's own configuration.

import type { SupabaseClient, User } from '@supabase/supabase-js'
import { validateFeed } from '@/lib/feedValidator'
import { generateFeed, loadFeedProducts } from '@/lib/feedGenerator'
import { describeMapping, logActivity } from '@/lib/activity'
import { clientMessage } from '@/lib/errors'
import { describeRule, isActiveRule, type FeedFilterRule } from '@/lib/feedFilters'
import { AUTO_SYNC_LABELS, isAutoSyncFrequency, isAutoSyncTime, type AutoSyncFrequency } from '@/lib/syncSchedule'

export type OpContext = { user: User; via?: string }
export type OpResult = { error?: string }

export type MappingEntry = {
  google_field: string
  mapping_type: string
  config: Record<string, unknown>
}

export type FilterRule = { field: string; operator: string; value: string; caseSensitive?: boolean }
export type FilterConfig = { operator: 'AND' | 'OR'; rules: FilterRule[] }

export type FeedMode = 'product' | 'variant'

const MODE_LABEL: Record<FeedMode, string> = { product: 'Pr. vare', variant: 'Pr. variant' }
export const scheduleLabel = (f: string | null | undefined, t: string | null | undefined) =>
  f ? (f === 'off' ? AUTO_SYNC_LABELS.off : `${AUTO_SYNC_LABELS[f as AutoSyncFrequency] ?? f} kl. ${t ?? '?'}`) : null

// ── Mapping ──────────────────────────────────────────────────────────────────

// Saves the given fields; an entry with mapping_type '' removes that field.
export async function applyMappings(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  entries: MappingEntry[]
): Promise<OpResult> {
  // The fields as they were, so the activity log can say what changed.
  const { data: prevRows } = await db
    .from('feed_mappings')
    .select('google_field, mapping_type, config')
    .eq('feed_id', feedId)
    .in('google_field', entries.map((e) => e.google_field))
  const prev = new Map(
    ((prevRows ?? []) as MappingEntry[]).map((r) => [r.google_field, r])
  )

  const toUpsert = entries.filter((e) => e.mapping_type !== '')
  const toDelete = entries
    .filter((e) => e.mapping_type === '')
    .map((e) => e.google_field)

  try {
    if (toDelete.length > 0) {
      const { error } = await db
        .from('feed_mappings')
        .delete()
        .eq('feed_id', feedId)
        .in('google_field', toDelete)
      if (error) throw new Error(error.message)
    }

    if (toUpsert.length > 0) {
      const { error } = await db
        .from('feed_mappings')
        .upsert(
          toUpsert.map((e) => ({
            feed_id: feedId,
            user_id: ctx.user.id,
            google_field: e.google_field,
            mapping_type: e.mapping_type,
            config: e.config,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: 'feed_id,google_field' }
        )
      if (error) throw new Error(error.message)
    }

    for (const e of entries) {
      const p = prev.get(e.google_field)
      const before = describeMapping(p?.mapping_type, p?.config)
      const after = describeMapping(e.mapping_type || null, e.config)
      if (before === after && JSON.stringify(p?.config ?? null) === JSON.stringify(e.mapping_type ? e.config : null)) continue
      await logActivity(db, {
        user: ctx.user,
        via: ctx.via,
        feedId,
        area: 'Mapping',
        action: !after ? `Felt ${e.google_field} fjernet` : !before ? `Felt ${e.google_field} mappet` : `Felt ${e.google_field} ændret`,
        before,
        after,
      })
    }

    // Two branches depending on whether the feed has been generated before:
    //   - feed_cache row exists  → just re-run validation and update the row
    //     (re-generating could be disruptive on every mapping change).
    //   - feed_cache row missing → first save for this feed; generate the
    //     feed for the first time, mirroring POST /api/feed/generate/[feedId]
    //     (generateFeed + validateFeed in parallel, then upsert).
    // Failures are swallowed: the mapping save is the user-visible operation
    // and must not be blocked by a generator/validator error.
    try {
      const { data: cacheRow } = await db
        .from('feed_cache')
        .select('feed_id')
        .eq('feed_id', feedId)
        .maybeSingle()

      if (cacheRow) {
        const result = await validateFeed(feedId)
        const { error: updateErr } = await db
          .from('feed_cache')
          .update({
            validation_status: result.status,
            validation_errors: result.issues,
          })
          .eq('feed_id', feedId)
        if (updateErr) {
          console.error('Kunne ikke gemme auto-validation i feed_cache:', updateErr)
        }
      } else {
        // One catalogue read shared by both.
        const products = await loadFeedProducts(feedId)
        const [{ xml, productCount }, validation] = await Promise.all([
          generateFeed(feedId, { products }),
          validateFeed(feedId, { products }).catch((err) => {
            console.error('Validering fejlede ved første generering:', err)
            return null as Awaited<ReturnType<typeof validateFeed>> | null
          }),
        ])

        const { error: upsertErr } = await db.from('feed_cache').upsert(
          {
            feed_id: feedId,
            xml_content: xml,
            generated_at: new Date().toISOString(),
            product_count: productCount,
            validation_status: validation?.status ?? null,
            validation_errors: validation?.issues ?? null,
          },
          { onConflict: 'feed_id' }
        )
        if (upsertErr) {
          console.error('Første feed-generering: upsert i feed_cache fejlede:', upsertErr.message)
        }
      }
    } catch (err) {
      console.error('Auto-generering/validering efter mapping save fejlede:', err)
    }

    return {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ── Include / exclude ────────────────────────────────────────────────────────

export async function applyFilters(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  include: FilterConfig,
  exclude: FilterConfig
): Promise<OpResult> {
  const { data: prevRows } = await db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId)
  const { error } = await db.from('feed_filters').upsert(
    [
      { feed_id: feedId, user_id: ctx.user.id, filter_type: 'include', operator: include.operator, rules: include.rules },
      { feed_id: feedId, user_id: ctx.user.id, filter_type: 'exclude', operator: exclude.operator, rules: exclude.rules },
    ],
    { onConflict: 'feed_id,filter_type' }
  )

  if (error) return { error: error.message }

  // One line per rule added or removed, and when AND/OR flipped.
  const text = (rules: FilterRule[] | null | undefined) =>
    (rules ?? []).map((r) => r as FeedFilterRule).filter(isActiveRule).map(describeRule)
  for (const [type, cfg, word] of [
    ['include', include, 'Inkludér'],
    ['exclude', exclude, 'Ekskludér'],
  ] as const) {
    const p = ((prevRows ?? []) as { filter_type: string; operator: string; rules: FilterRule[] }[]).find((r) => r.filter_type === type)
    const before = text(p?.rules)
    const after = text(cfg.rules)
    for (const r of after.filter((x) => !before.includes(x))) {
      await logActivity(db, { user: ctx.user, via: ctx.via, feedId, area: 'Inkludér / ekskludér', action: `${word}-regel tilføjet`, after: r })
    }
    for (const r of before.filter((x) => !after.includes(x))) {
      await logActivity(db, { user: ctx.user, via: ctx.via, feedId, area: 'Inkludér / ekskludér', action: `${word}-regel fjernet`, before: r })
    }
    if (p && p.operator !== cfg.operator && after.length > 1) {
      await logActivity(db, { user: ctx.user, via: ctx.via, feedId, area: 'Inkludér / ekskludér', action: `${word}: kobling ændret`, before: p.operator === 'AND' ? 'Alle regler' : 'Én af reglerne', after: cfg.operator === 'AND' ? 'Alle regler' : 'Én af reglerne' })
    }
  }
  return {}
}

// ── Settings ─────────────────────────────────────────────────────────────────

export async function applyFeedMode(db: SupabaseClient, ctx: OpContext, feedId: string, mode: FeedMode): Promise<OpResult> {
  const { data: prev } = await db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle()
  const { error } = await db
    .from('feed_settings')
    .upsert({ feed_id: feedId, user_id: ctx.user.id, feed_mode: mode }, { onConflict: 'feed_id' })
  if (error) return { error: error.message }
  const before = (prev?.feed_mode as FeedMode | undefined) ?? 'product'
  if (before !== mode) {
    await logActivity(db, { user: ctx.user, via: ctx.via, feedId, area: 'Settings', action: 'Niveau ændret', before: MODE_LABEL[before], after: MODE_LABEL[mode] })
  }
  return {}
}

export async function applyFeedSchedule(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  frequency: string,
  time: string
): Promise<OpResult> {
  if (!isAutoSyncFrequency(frequency)) return { error: 'Ugyldig frekvens' }
  if (!isAutoSyncTime(time)) return { error: 'Ugyldigt tidspunkt (HH:MM)' }
  const { data: prev } = await db.from('feeds').select('*').eq('id', feedId).maybeSingle()
  const { error } = await db.from('feeds').update({ auto_sync_frequency: frequency, auto_sync_time: time }).eq('id', feedId)
  if (error) return { error: clientMessage(error, 'applyFeedSchedule') }
  const o = (prev ?? {}) as { auto_sync_frequency?: string; auto_sync_time?: string }
  await logActivity(db, {
    user: ctx.user,
    via: ctx.via,
    feedId,
    area: 'Settings',
    action: 'Tidsplan for feedet ændret',
    before: scheduleLabel(o.auto_sync_frequency, o.auto_sync_time),
    after: scheduleLabel(frequency, time),
  })
  return {}
}

// Settings → Schedule → Fetch performance (migration 054). Only for a feed that
// already has a Google Ads row: without an account there is nothing to fetch.
// Writes the schedule only — updated_at stays, since the Labels page reads it
// as "the measuring settings changed".
export async function applyAdsSchedule(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  frequency: string,
  time: string
): Promise<OpResult> {
  if (!isAutoSyncFrequency(frequency)) return { error: 'Ugyldig frekvens' }
  if (!isAutoSyncTime(time)) return { error: 'Ugyldigt tidspunkt (HH:MM)' }
  const { data: prev } = await db
    .from('google_ads_feed_settings')
    .select('auto_sync_frequency, auto_sync_time')
    .eq('feed_id', feedId)
    .maybeSingle()
  const { data, error } = await db
    .from('google_ads_feed_settings')
    .update({ auto_sync_frequency: frequency, auto_sync_time: time })
    .eq('feed_id', feedId)
    .select('feed_id')
  if (error) return { error: clientMessage(error, 'applyAdsSchedule') }
  if (!data?.length) return { error: 'Vælg en Google Ads-konto først' }
  await logActivity(db, {
    user: ctx.user,
    via: ctx.via,
    feedId,
    area: 'Settings',
    action: 'Tidsplan for performance ændret',
    before: scheduleLabel(prev?.auto_sync_frequency, prev?.auto_sync_time),
    after: scheduleLabel(frequency, time),
  })
  return {}
}
