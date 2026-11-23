// Lookup table mapping (mapping_type 'LOOKUP').
//
// Read one source field, look its value up in a table, and output the value on
// the matching row: "if it is this, write that". Typical uses are translating
// shop values into the channel's vocabulary (colour names per language, the
// shop's categories → google_product_category, gender codes).
//
// Shared by the feed generator (server) and the mapping preview (client), so
// both resolve a lookup the same way. Pure string → string; safe on the client.
//
// Config (stored as JSONB on feed_mappings.config):
//
//   field          source field token, read like a FIELD mapping
//   rows           [{ from, to }] in priority order — the first match wins
//   match          'exact' (default): the whole value equals `from`
//                  'contains': the value contains `from`
//   caseSensitive  default false — "Rot" matches "rot"
//   fallback       what to output when no row matches:
//                  'source' (default) the source value unchanged
//                  'empty'  nothing
//                  'static' fallbackValue
//
// Values are compared trimmed. Rows with an empty `from` are ignored, so a
// half-filled row in the editor never matches everything.

export type LookupRow = { from: string; to: string }

export type LookupConfig = {
  field?: string
  rows?: LookupRow[]
  match?: 'exact' | 'contains'
  caseSensitive?: boolean
  fallback?: 'source' | 'empty' | 'static'
  fallbackValue?: string
}

export function applyLookup(source: string, config: LookupConfig): string {
  const sensitive = config.caseSensitive ?? false
  const norm = (s: string) => (sensitive ? s.trim() : s.trim().toLocaleLowerCase('da-DK'))
  const value = norm(source)
  const contains = config.match === 'contains'

  for (const row of config.rows ?? []) {
    const from = norm(row.from ?? '')
    if (!from) continue
    if (contains ? value.includes(from) : value === from) return row.to ?? ''
  }

  switch (config.fallback) {
    case 'empty':
      return ''
    case 'static':
      return config.fallbackValue ?? ''
    default:
      return source
  }
}

// Rows pasted from a spreadsheet: one row per line, the two columns separated
// by a tab (what Excel and Google Sheets copy), or else by ';' or ','. A first
// line that looks like a header ("fra"/"from" … "til"/"to") is skipped.
export function parseLookupPaste(text: string): LookupRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const rows: LookupRow[] = []
  for (const [i, line] of lines.entries()) {
    const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ','
    const at = line.indexOf(sep)
    const from = (at === -1 ? line : line.slice(0, at)).trim().replace(/^"|"$/g, '')
    const to = (at === -1 ? '' : line.slice(at + 1)).trim().replace(/^"|"$/g, '')
    if (i === 0 && /^(fra|from|kilde|source)$/i.test(from) && /^(til|to|værdi|value)$/i.test(to)) continue
    if (from) rows.push({ from, to })
  }
  return rows
}
