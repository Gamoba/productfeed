// Display formatting for the UI (en-GB): numbers, short relative timestamps,
// and country/language names. Pure functions, safe on server and client.

const nf = new Intl.NumberFormat('en-GB')

// 2786 → "2,786"
export function formatNumber(n: number): string {
  return nf.format(n)
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// "today 06:15", "yesterday 14:02", "12 Nov", "12 Nov 2025" (other years).
export function formatWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (sameDay(d, now)) return `today ${time}`
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(d, yesterday)) return `yesterday ${time}`
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
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
