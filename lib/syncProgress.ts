import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError } from '@/lib/errors'

// Live state of a feed's product sync (migration 049): the lock that keeps two
// syncs of the same feed from running at once, and the progress the UI polls.
// Writes go to OUR database only — never to Shopify.

// A 'running' claim older than this is treated as dead: the function that held
// it crashed or was killed (Vercel stops it at maxDuration = 300 s) and never
// released it. Kept above that ceiling so a live sync is never taken over.
export const SYNC_STALE_MS = 6 * 60 * 1000

// Thrown when another sync of the same feed holds the claim. 409 so the UI can
// attach to the running sync's progress instead of showing an error.
export class SyncAlreadyRunningError extends AppError {
  startedAt: string | null
  constructor(startedAt: string | null) {
    super('A sync is already running for this feed. Its progress is shown here until it finishes.', 409)
    this.name = 'SyncAlreadyRunningError'
    this.startedAt = startedAt
  }
}

export type SyncStep = (progress: number, phase: string, detail?: string) => void

export type SyncRun = {
  /**
   * Reports progress (0–100, never moves backwards) and the current phase.
   * Fire-and-forget: a failed progress write is logged, never fails the sync.
   * Written at once when the phase changes, otherwise at most once a second —
   * a 60k-row metafield save would otherwise write the feed row 4× a second.
   */
  step: SyncStep
  finish: (outcome: { ok: true } | { ok: false; message: string }) => Promise<void>
}

const WRITE_INTERVAL_MS = 1000

// Claims the feed for a sync, or throws SyncAlreadyRunningError.
//
// One conditional UPDATE is the whole lock: it only matches when no live sync
// holds the feed, and Postgres re-checks that condition after taking the row
// lock, so of two simultaneous claims exactly one matches.
export async function startSyncRun(db: SupabaseClient, feedId: string): Promise<SyncRun> {
  const startedAt = new Date().toISOString()
  const staleBefore = new Date(Date.now() - SYNC_STALE_MS).toISOString()

  const { data, error } = await db
    .from('feeds')
    .update({
      sync_status: 'running',
      sync_started_at: startedAt,
      sync_finished_at: null,
      sync_progress: 0,
      sync_phase: 'Starting',
      sync_error: null,
    })
    .eq('id', feedId)
    .or(`sync_status.is.null,sync_status.neq.running,sync_started_at.lt."${staleBefore}"`)
    .select('id')
  if (error) throw new Error(`Could not claim sync for feed ${feedId}: ${error.message}`)

  if (!data?.length) {
    const { data: feed } = await db
      .from('feeds')
      .select('sync_started_at')
      .eq('id', feedId)
      .maybeSingle()
    if (!feed) throw new AppError('Feed not found', 404)
    throw new SyncAlreadyRunningError((feed.sync_started_at as string | null) ?? null)
  }

  let progress = 0
  let phase = 'Starting'
  let lastWrite = 0
  // Writes are chained so they land in order; a slow write can't let an older
  // progress value overwrite a newer one.
  let chain: Promise<void> = Promise.resolve()

  // Every write is scoped to OUR claim (sync_started_at), so a run that was
  // declared stale and taken over can't scribble over the newer run's state.
  function write(fields: Record<string, unknown>): Promise<void> {
    chain = chain.then(async () => {
      const { error: err } = await db
        .from('feeds')
        .update(fields)
        .eq('id', feedId)
        .eq('sync_started_at', startedAt)
      if (err) console.error(`[sync] progress write failed for feed ${feedId}:`, err.message)
    })
    return chain
  }

  const step: SyncStep = (value, nextPhase, detail) => {
    progress = Math.max(progress, Math.min(99, Math.round(value)))
    const label = detail ? `${nextPhase} · ${detail}` : nextPhase
    const phaseChanged = nextPhase !== phase
    phase = nextPhase
    if (!phaseChanged && Date.now() - lastWrite < WRITE_INTERVAL_MS) return
    lastWrite = Date.now()
    void write({ sync_progress: progress, sync_phase: label })
  }

  const finish: SyncRun['finish'] = async (outcome) => {
    const finishedAt = new Date().toISOString()
    await write(
      outcome.ok
        ? {
            sync_status: 'ok',
            sync_progress: 100,
            sync_phase: 'Done',
            sync_finished_at: finishedAt,
            // "Last synced" everywhere (migration 051). max(products.synced_at)
            // no longer moves for products that didn't change.
            last_synced_at: finishedAt,
          }
        : {
            sync_status: 'error',
            sync_error: outcome.message,
            sync_finished_at: new Date().toISOString(),
          }
    )
  }

  return { step, finish }
}

export type SyncStatus = {
  status: 'idle' | 'running' | 'ok' | 'error'
  progress: number
  phase: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

type FeedSyncRow = {
  sync_status: string | null
  sync_started_at: string | null
  sync_finished_at: string | null
  sync_progress: number | null
  sync_phase: string | null
  sync_error: string | null
}

// The feed row's sync columns as the UI should see them. A 'running' claim past
// the stale window is reported as the failure it is, not as forever-running.
export function toSyncStatus(row: FeedSyncRow): SyncStatus {
  const base = {
    progress: row.sync_progress ?? 0,
    phase: row.sync_phase,
    startedAt: row.sync_started_at,
    finishedAt: row.sync_finished_at,
    error: row.sync_error,
  }
  if (row.sync_status === 'running') {
    const age = row.sync_started_at ? Date.now() - new Date(row.sync_started_at).getTime() : Infinity
    if (age > SYNC_STALE_MS) {
      return { ...base, status: 'error', error: 'The sync stopped unexpectedly. Start it again.' }
    }
    return { ...base, status: 'running' }
  }
  if (row.sync_status === 'ok' || row.sync_status === 'error') return { ...base, status: row.sync_status }
  return { ...base, status: 'idle' }
}

export const SYNC_STATUS_COLUMNS =
  'sync_status, sync_started_at, sync_finished_at, sync_progress, sync_phase, sync_error'
