// Google Ads labels (Labels page): changes shared with the MCP tools.
//
// The rules and the recalculation live in lib/googleAdsBuckets, the same as for
// the Labels page's API routes. These add what the routes add around them: the
// Activity log line, and recalculating the label afterwards like the page does,
// so a changed rule is reflected in the feed without a separate step.

import type { SupabaseClient } from '@supabase/supabase-js'
import { logActivity } from '@/lib/activity'
import { AppError, clientMessage } from '@/lib/errors'
import { recomputeLabel, saveBucket, saveLabel, type Bucket, type CustomLabel } from '@/lib/googleAdsBuckets'
import type { OpContext, OpResult } from '@/lib/ops/feedConfig'

export type LabelInput = Partial<Pick<CustomLabel, 'name' | 'slot' | 'level' | 'window_days' | 'emit_to_feed' | 'description'>> & {
  id?: string
}
export type LabelBucketInput = Partial<
  Pick<Bucket, 'label_id' | 'name' | 'value' | 'priority' | 'match_type' | 'rules' | 'is_fallback' | 'description'>
> & { id?: string }

const message = (err: unknown, context: string) => (err instanceof AppError ? err.message : clientMessage(err, context))

// Best effort: a label on a feed without Google Ads figures can't be computed
// yet, which must not undo the saved change.
async function recalc(db: SupabaseClient, feedId: string, labelId: string): Promise<void> {
  try {
    await recomputeLabel(db, feedId, labelId)
  } catch (err) {
    if (err instanceof AppError) console.info(`[ops/labels] not recalculated: ${err.message}`)
    else console.error('[ops/labels] recalculation after change failed:', err)
  }
}

export async function applyLabelSave(db: SupabaseClient, ctx: OpContext, feedId: string, label: LabelInput): Promise<OpResult> {
  try {
    const saved = await saveLabel(db, feedId, label)
    const slot = saved.slot !== null ? ` (custom_label_${saved.slot})` : ''
    await logActivity(db, {
      user: ctx.user,
      via: ctx.via,
      feedId,
      area: 'Labels',
      action: label.id ? 'Label ændret' : 'Label oprettet',
      after: `${saved.name}${slot}`,
    })
    if (label.id) await recalc(db, feedId, saved.id)
    return {}
  } catch (err) {
    return { error: message(err, 'applyLabelSave') }
  }
}

export async function applyLabelBucketSave(
  db: SupabaseClient,
  ctx: OpContext,
  feedId: string,
  bucket: LabelBucketInput
): Promise<OpResult> {
  try {
    const saved = await saveBucket(db, feedId, bucket)
    await logActivity(db, {
      user: ctx.user,
      via: ctx.via,
      feedId,
      area: 'Labels',
      action: bucket.id ? 'Bucket ændret' : 'Bucket oprettet',
      after: saved.name === saved.value ? saved.name : `${saved.name} → ${saved.value}`,
    })
    await recalc(db, feedId, saved.label_id)
    return {}
  } catch (err) {
    return { error: message(err, 'applyLabelBucketSave') }
  }
}
