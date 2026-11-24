'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { validateFeed } from '@/lib/feedValidator'
import { generateFeed, loadFeedProducts } from '@/lib/feedGenerator'
import { patternProblems, type ExtractConfig } from '@/lib/mappingExtract'

export type MappingEntry = {
  google_field: string
  mapping_type: string
  config: Record<string, unknown>
}

// Extract patterns the generator will skip (too long, nested repetition,
// invalid syntax). Saving still goes through — a half-finished list is a valid
// state, the bad rows are just ignored — but the user is told, so a refused
// pattern can't pass for one that simply matches nothing.
function extractWarnings(entries: MappingEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.mapping_type !== 'EXTRACT') continue
    const cfg = e.config as ExtractConfig
    for (const p of patternProblems(cfg.patterns)) {
      out.push(`${e.google_field}: pattern ${p.index + 1} is skipped (${p.error})`)
    }
  }
  return out
}

export async function saveMappings(
  feedId: string,
  entries: MappingEntry[]
): Promise<{ error?: string; warnings?: string[] }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed not found' }

  const db = adminDb()

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
            user_id: user.id,
            google_field: e.google_field,
            mapping_type: e.mapping_type,
            config: e.config,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: 'feed_id,google_field' }
        )
      if (error) throw new Error(error.message)
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

    const warnings = extractWarnings(toUpsert)
    return warnings.length > 0 ? { warnings } : {}
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
