// Automatic product sync schedule — the part shared by the settings UI (labels,
// validation) and the cron route (is this feed due?).
//
// Pure functions only, so the module is safe to import from a client component
// and the due-logic can be checked without a database.

export const AUTO_SYNC_FREQUENCIES = ['off', 'hourly', '6h', '12h', 'daily'] as const
export type AutoSyncFrequency = (typeof AUTO_SYNC_FREQUENCIES)[number]

export const AUTO_SYNC_LABELS: Record<AutoSyncFrequency, string> = {
  off: 'Off',
  hourly: 'Every hour',
  '6h': 'Every 6 hours',
  '12h': 'Every 12 hours',
  daily: 'Once a day',
}

export const DEFAULT_AUTO_SYNC_FREQUENCY: AutoSyncFrequency = 'daily'
export const DEFAULT_AUTO_SYNC_TIME = '00:01'

// Schedules are written and read in Danish time — that is the clock the users
// think in, and Vercel cron itself only speaks UTC.
export const AUTO_SYNC_TIMEZONE = 'Europe/Copenhagen'

const INTERVAL_MINUTES: Record<Exclude<AutoSyncFrequency, 'off'>, number> = {
  hourly: 60,
  '6h': 6 * 60,
  '12h': 12 * 60,
  daily: 24 * 60,
}

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

export function isAutoSyncFrequency(v: unknown): v is AutoSyncFrequency {
  return typeof v === 'string' && (AUTO_SYNC_FREQUENCIES as readonly string[]).includes(v)
}

export function isAutoSyncTime(v: unknown): v is string {
  return typeof v === 'string' && TIME_RE.test(v)
}

// Minutes since local midnight in AUTO_SYNC_TIMEZONE, with seconds as a fraction.
function localMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: AUTO_SYNC_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return get('hour') * 60 + get('minute') + get('second') / 60
}

// The most recent scheduled moment at or before `now`.
//
// Slots are `time`, `time + interval`, `time + 2·interval`, … on the local
// clock, wrapping across midnight. Computed as "how far back is the last slot",
// so it works without building a local Date. On the two DST-change nights a
// slot that straddles the switch lands an hour off — one sync early or late,
// which is harmless for a read-only sync.
export function lastScheduledSlot(
  now: Date,
  frequency: AutoSyncFrequency,
  time: string
): Date | null {
  if (frequency === 'off' || !isAutoSyncTime(time)) return null
  const interval = INTERVAL_MINUTES[frequency]
  const [h, m] = time.split(':').map(Number)
  const anchor = h * 60 + m
  const minutesBack = (((localMinuteOfDay(now) - anchor) % interval) + interval) % interval
  return new Date(now.getTime() - minutesBack * 60_000)
}

// A feed is due when its last claim predates the latest slot. A feed that has
// never been auto-synced is due straight away.
export function isAutoSyncDue(
  now: Date,
  frequency: AutoSyncFrequency,
  time: string,
  lastAutoSyncAt: string | null
): boolean {
  const slot = lastScheduledSlot(now, frequency, time)
  if (!slot) return false
  if (!lastAutoSyncAt) return true
  return new Date(lastAutoSyncAt).getTime() < slot.getTime()
}
