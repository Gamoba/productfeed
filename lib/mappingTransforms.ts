// Text operations shared by the feed generator (server) and the mapping
// preview (client).
//
// Two things live here:
//
//  1. `stripHtml` — the single implementation of "turn body_html into plain
//     text". It used to be duplicated in lib/feedGenerator.ts and
//     app/mapping/MappingClient.tsx, which is exactly how the preview and the
//     generated feed drift apart. One copy, imported by both.
//
//  2. `applyTransforms` — the filter layer. A mapping produces ONE value from
//     its main function (FIELD, COMBINE, STRIP_HTML, …); transforms are
//     additional operations stacked on top of that value, in order. This is
//     what lets a field be "strip HTML, *then* find & replace" without
//     inventing a combinatorial explosion of mapping types.
//
// Everything here is pure string → string, so the module is safe to import
// from a client component.

// ── Types ──────────────────────────────────────────────────────────────────

export type FindReplacePair = { find: string; replace: string }

export type TransformType = 'STRIP_HTML' | 'FIND_REPLACE' | 'TRUNCATE' | 'PREFIX_SUFFIX'

// A transform carries the config of the mapping type it mirrors. Kept as one
// open shape (rather than a discriminated union with required fields) because
// it is stored as JSONB and edited incrementally in the UI — a half-filled
// transform must round-trip without losing keys.
export type Transform = {
  type: TransformType
  pairs?: FindReplacePair[]
  maxChars?: number
  prefix?: string
  suffix?: string
}

export const TRANSFORM_LABELS: Record<TransformType, string> = {
  STRIP_HTML: 'Strip HTML',
  FIND_REPLACE: 'Find & Replace',
  TRUNCATE: 'Truncate',
  PREFIX_SUFFIX: 'Prefix / Suffix',
}

// ── HTML → text ────────────────────────────────────────────────────────────

// The HTML 4 Latin-1 entity block is exactly code points 160–255 in this order,
// so the whole set is one list rather than 96 hand-written pairs. This block is
// what a Danish catalogue actually needs: &aring;, &oslash;, &aelig; and friends
// all live here, and leaving them undecoded put a literal "m&aring;neder" in the
// feed.
// The order IS the spec, so a single missing name silently shifts every entity
// after it by one (&aring; came out as ä). The anchors in LATIN1_ANCHORS below
// pin it; don't edit this list without running them.
const LATIN1_ENTITIES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 ' +
  'frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute ' +
  'Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml ' +
  'times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc ' +
  'atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc ' +
  'uuml yacute thorn yuml'

const NAMED_ENTITIES: Record<string, string> = (() => {
  const map: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    // The typographic punctuation Shopify's rich-text editor emits.
    hellip: '…',
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    bull: '•',
    euro: '€',
    trade: '™',
  }
  // Keyed by the name's EXACT casing: HTML entities are case-sensitive, and
  // &Auml; (Ä) and &auml; (ä) are different characters.
  LATIN1_ENTITIES.split(' ').forEach((name, i) => {
    map[name] = String.fromCharCode(160 + i)
  })
  return map
})()

// Spot-checks that pin LATIN1_ENTITIES to the right code points — the list is
// positional, so an omission shifts everything after it. Exported for the
// check script rather than asserted at import time: a malformed feed value is
// bad, a module that throws on load is worse.
export const LATIN1_ANCHORS: [string, string][] = [
  ['deg', '°'],
  ['reg', '®'],
  ['Auml', 'Ä'],
  ['aring', 'å'],
  ['oslash', 'ø'],
  ['aelig', 'æ'],
  ['yuml', 'ÿ'],
]

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    // Case-sensitive on purpose (see NAMED_ENTITIES). An unknown entity is left
    // verbatim — guessing would corrupt real text.
    return NAMED_ENTITIES[body] ?? match
  })
}

// Block-level tags. BOTH the opening and the closing tag end a line, so the
// result follows the document's structure rather than wherever the author
// happened to put newlines in the source.
const BLOCK_TAG_RE =
  /<\/?\s*(p|div|li|ul|ol|dl|dd|dt|tr|td|th|table|thead|tbody|section|article|header|footer|figure|figcaption|blockquote|pre|h[1-6])\b[^>]*>/gi

const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const BR_RE = /<\s*br\s*\/?\s*>/gi

// Turns HTML into plain text while KEEPING the document's line structure.
//
// The old implementation collapsed every whitespace run — including the breaks
// implied by </p> and <br> — so a description with ten paragraphs came out as
// one unbroken sentence. Google Shopping's `description` accepts line breaks and
// a wall of text is measurably worse to read, so block boundaries now survive:
// a <br>, and either half of a block tag, each end the line.
//
// Every run of newlines collapses to exactly ONE, so "</p>\n  <p>" and "</p><p>"
// produce the same text — insignificant source whitespace cannot change the
// feed. Horizontal whitespace still collapses to single spaces.
export function stripHtml(html: string): string {
  if (!html) return ''
  const text = html
    // Script/style bodies are not content — drop them wholesale, tags and all.
    // Must run first, while those bodies are still intact.
    .replace(SCRIPT_STYLE_RE, '')
    .replace(BR_RE, '\n')
    .replace(BLOCK_TAG_RE, '\n')
    .replace(/<[^>]*>/g, '')

  return decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    // Collapse horizontal whitespace only — "not-whitespace, negated, except
    // newline" — so the line structure built above survives. A decoded &nbsp;
    // is whitespace to \s and normalises here too.
    .replace(/[^\S\n]+/g, ' ')
    // Any run of newlines, with whatever spacing around it, becomes exactly one.
    .replace(/[^\S\n]*\n\s*/g, '\n')
    .trim()
}

// ── The filter layer ───────────────────────────────────────────────────────

function applyTransform(value: string, t: Transform): string {
  switch (t.type) {
    case 'STRIP_HTML':
      return stripHtml(value)

    case 'FIND_REPLACE': {
      let out = value
      for (const pair of t.pairs ?? []) {
        // An empty `find` would match everywhere; skip it rather than corrupt
        // the value while the user is still typing the pair.
        if (pair.find) out = out.split(pair.find).join(pair.replace)
      }
      return out
    }

    case 'TRUNCATE': {
      const max = Number(t.maxChars ?? 500)
      if (!Number.isFinite(max) || max <= 0) return value
      return value.slice(0, max)
    }

    case 'PREFIX_SUFFIX':
      // Mirrors the PREFIX_SUFFIX mapping type: an empty value stays empty
      // rather than emitting a lone prefix+suffix with nothing between them.
      if (!value) return ''
      return `${t.prefix ?? ''}${value}${t.suffix ?? ''}`

    default:
      return value
  }
}

// Applies each transform in order. Order is the user's — it is the whole point
// of the feature (strip the HTML first, then replace inside the plain text).
export function applyTransforms(value: string, transforms: unknown): string {
  if (!Array.isArray(transforms) || transforms.length === 0) return value
  let out = value
  for (const t of transforms as Transform[]) {
    if (t && typeof t.type === 'string') out = applyTransform(out, t)
  }
  return out
}

// Reads the transform list off a mapping config, tolerating legacy configs that
// have no `transforms` key at all.
export function configTransforms(config: Record<string, unknown> | undefined): Transform[] {
  const raw = config?.transforms
  return Array.isArray(raw) ? (raw as Transform[]) : []
}
