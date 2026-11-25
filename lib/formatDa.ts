// Display formatting for the UI (en-GB): numbers, short relative timestamps,
// and country/language names. Pure functions, safe on server and client.

const nf = new Intl.NumberFormat('en-GB')

// 2786 → "2,786"
export function formatNumber(n: number): string {
  return nf.format(n)
}

// Times are always shown in Danish time. Using the machine's own zone made the
// server (UTC on Vercel) and the browser render different text for the same
// timestamp, which React reports as a hydration error and re-renders.
export const DISPLAY_TIME_ZONE = 'Europe/Copenhagen'

// Calendar day in Danish time, as "YYYY-MM-DD".
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const dayKey = (d: Date) => dayFmt.format(d)

function previousDayKey(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

// "today 06:15", "yesterday 14:02", "12 Nov", "12 Nov 2025" (other years).
export function formatWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: DISPLAY_TIME_ZONE })
  const day = dayKey(d)
  const today = dayKey(now)
  if (day === today) return `today ${time}`
  if (day === previousDayKey(today)) return `yesterday ${time}`
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: DISPLAY_TIME_ZONE,
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
  })
}

function capitalize(s: string): string {
  return s ? s[0].toLocaleUpperCase('en-GB') + s.slice(1) : s
}

let regionNames: Intl.DisplayNames | null = null
let languageNames: Intl.DisplayNames | null = null

// "DE" → "Germany". Falls back to the code.
export function countryName(code: string | null | undefined): string {
  if (!code) return ''
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return regionNames.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

// "de" → "German", "pt-BR" → "Brazilian Portuguese". Falls back to the code.
export function languageName(locale: string | null | undefined): string {
  if (!locale) return ''
  try {
    languageNames ??= new Intl.DisplayNames(['en'], { type: 'language' })
    return capitalize(languageNames.of(locale) ?? locale)
  } catch {
    return locale
  }
}
