// The EXTRACT mapping type ("Extract with pattern"): pull part of a field out
// with a regular expression and rebuild it through a template.
//
//   source  "…/products/fuga-v3-3637-sort"
//   pattern  -(\d{2})(\d{2})-[a-z]+$
//   template $1/$2
//   result   "36/37"
//
// A mapping holds an ordered list of patterns. They are tried top-down and the
// FIRST that matches produces the value — the same priority model as the
// ELSE IF rules in lib/mappingRules. When none matches the value is '' (the
// tag is then left out of the feed, like any empty value).
//
// One lookup table per mapping rewrites each captured group before it goes
// into the template (`ml → M/L`, `sort → Sort`). It is per mapping rather than
// per pattern because a size mapping and a colour mapping are separate
// mappings anyway, and a per-pattern table means retyping it for every pattern.
//
// Shared by the feed generator (server) and the mapping preview (client), so
// the two can't drift. Pure string → string; safe to import from a client
// component.
//
// ── Safety ─────────────────────────────────────────────────────────────────
//
// The patterns are user-written and run server-side over every product in a
// feed. A catastrophically backtracking pattern — `(a+)+$` — can lock the Node
// process for minutes on one input. Three guards, all enforced HERE (on the
// evaluation path, not just in the editor), so a pattern saved through the API
// directly is held to the same rules:
//   - patterns longer than MAX_PATTERN_LENGTH are refused (a sanity bound,
//     not the real protection);
//   - nested repetition (a quantified group whose body ends in a quantifier,
//     e.g. `(a+)+`, `(\w*)*`, `(x{2,})+`) is refused — that is the classic
//     exponential shape;
//   - the input is cut to MAX_INPUT_LENGTH before matching.
// That stops the common cases, not every possible one (alternation overlap
// such as `(a|aa)+` is not detected). If patterns ever come from people
// outside the team, swap RegExp for RE2 (re2-wasm), which cannot backtrack.

// ── Types ──────────────────────────────────────────────────────────────────

export type ExtractPattern = {
  pattern: string
  template: string
  // Case-insensitive match. Optional so a hand-written config without it
  // still works; the editor sets it on for new patterns.
  ignoreCase?: boolean
}

export type LookupEntry = { from: string; to: string }

// The extract-specific part of a mapping config. `onlyIf` and `transforms`
// live alongside it on the same config object, exactly as for other types.
export type ExtractConfig = {
  field?: string
  patterns?: ExtractPattern[]
  lookup?: LookupEntry[]
}

// `patternIndex` is the 0-based index of the pattern that matched, or -1.
export type ExtractResult = { value: string; patternIndex: number }

// Length is not what keeps a pattern safe — the nested-repetition check and the
// input cap are — so this is just a sanity bound. Long alternations (a list of
// every colour name) are a real use case and easily pass a few hundred chars.
export const MAX_PATTERN_LENGTH = 2000
export const MAX_INPUT_LENGTH = 2000

// ── Compiling (cached) ─────────────────────────────────────────────────────

// A group ending in an UNBOUNDED quantifier (`+`, `*`, `{n,}`, lazy or not)
// that is itself repeated without bound: `(a+)+`, `(\w*)*`, `(x{2,}){1,}`.
// Bounded counts such as `(\d{2}){2}` are fine and not flagged. The group body
// may contain escapes and character classes but no nested parentheses —
// enough for the shapes people actually write.
const NESTED_QUANTIFIER_RE =
  /\((?:\\.|\[(?:\\.|[^\]\\])*\]|[^()\\])*(?:[+*]|\{\d*,\})\??\)(?:[+*]|\{\d*,\})/

type Compiled = { ok: true; re: RegExp } | { ok: false; error: string }

// Compiling is the expensive part, and the generator evaluates the same few
// patterns once per product (× per variant). Keyed by flags + source; bounded
// so an editor session that types hundreds of intermediate patterns can't grow
// it forever.
const CACHE_LIMIT = 500
const compileCache = new Map<string, Compiled>()

function compile(pattern: string, ignoreCase: boolean): Compiled {
  const key = `${ignoreCase ? 'i' : '-'}:${pattern}`
  const hit = compileCache.get(key)
  if (hit) return hit

  let out: Compiled
  if (pattern.length > MAX_PATTERN_LENGTH) {
    out = { ok: false, error: `Pattern is longer than ${MAX_PATTERN_LENGTH} characters` }
  } else if (NESTED_QUANTIFIER_RE.test(pattern)) {
    out = {
      ok: false,
      error: 'Nested repetition such as (a+)+ is not allowed — it can make feed generation hang',
    }
  } else {
    try {
      // No `g`/`y`: those make RegExp stateful (lastIndex) between calls.
      out = { ok: true, re: new RegExp(pattern, ignoreCase ? 'i' : '') }
    } catch (err) {
      out = { ok: false, error: err instanceof Error ? err.message : 'Invalid pattern' }
    }
  }

  if (compileCache.size >= CACHE_LIMIT) compileCache.clear()
  compileCache.set(key, out)
  return out
}

/** Why a pattern can't be used, or null when it's fine (or still empty). */
export function patternError(pattern: string, ignoreCase = false): string | null {
  if (!pattern) return null
  const c = compile(pattern, ignoreCase)
  return c.ok ? null : c.error
}

export type PatternProblem = { index: number; error: string }

/**
 * Every non-empty pattern in the list that the evaluator will skip, with why.
 * The evaluator skips them silently (so one bad row never breaks the rest);
 * this is what the editor, the coverage test and the save warning report.
 */
export function patternProblems(patterns: ExtractPattern[] | undefined): PatternProblem[] {
  if (!Array.isArray(patterns)) return []
  const out: PatternProblem[] = []
  patterns.forEach((p, index) => {
    const error = p?.pattern ? patternError(p.pattern, !!p.ignoreCase) : null
    if (error) out.push({ index, error })
  })
  return out
}

// ── Lookup ─────────────────────────────────────────────────────────────────

// Lookup is matched case-insensitively on the trimmed `from`, so `ML`, `ml`
// and `Ml` all hit one row. Built once per lookup array (the generator passes
// the same config object for every product).
const lookupCache = new WeakMap<LookupEntry[], Map<string, string>>()

function lookupMap(lookup: LookupEntry[] | undefined): Map<string, string> | null {
  if (!Array.isArray(lookup) || lookup.length === 0) return null
  let map = lookupCache.get(lookup)
  if (!map) {
    map = new Map()
    for (const e of lookup) {
      const from = e?.from?.trim().toLowerCase()
      // First row wins on duplicates, matching the top-down feel of the rest.
      if (from && !map.has(from)) map.set(from, e.to ?? '')
    }
    lookupCache.set(lookup, map)
  }
  return map
}

// ── Template expansion ─────────────────────────────────────────────────────

// $1–$9   numbered group        $<name>  named group
// $&      the whole match       $$       a literal $
// Anything else after `$` is left as written. We expand ourselves rather than
// using String.replace(re, template): that returns the WHOLE input with the
// match swapped in, and we want only the template's output.
const TEMPLATE_TOKEN_RE = /\$(\$|&|[1-9]|<([A-Za-z_][A-Za-z0-9_]*)>)/g

function expandTemplate(
  template: string,
  match: RegExpExecArray,
  lookup: Map<string, string> | null
): string {
  const mapped = (raw: string | undefined): string => {
    const v = raw ?? '' // an optional group that didn't take part is ''
    if (!lookup || !v) return v
    return lookup.get(v.trim().toLowerCase()) ?? v
  }
  return template.replace(TEMPLATE_TOKEN_RE, (token, body: string, name?: string) => {
    if (body === '$') return '$'
    if (body === '&') return mapped(match[0])
    if (name !== undefined) return mapped(match.groups?.[name])
    const n = Number(body)
    // A $n beyond the pattern's group count is left verbatim so the preview
    // shows the mistake instead of silently dropping it.
    return n < match.length ? mapped(match[n]) : token
  })
}

// ── Evaluation ─────────────────────────────────────────────────────────────

/**
 * Runs the patterns top-down against `input`; the first that matches builds the
 * value. Empty, invalid or refused patterns are skipped, so a half-typed
 * pattern never breaks the rest of the list.
 */
export function extractWithPatterns(
  input: string,
  patterns: ExtractPattern[] | undefined,
  lookup?: LookupEntry[]
): ExtractResult {
  if (!input || !Array.isArray(patterns) || patterns.length === 0) {
    return { value: '', patternIndex: -1 }
  }
  const subject = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input
  const table = lookupMap(lookup)

  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]
    if (!p?.pattern) continue
    const c = compile(p.pattern, !!p.ignoreCase)
    if (!c.ok) continue
    const m = c.re.exec(subject)
    if (!m) continue
    return { value: expandTemplate(p.template ?? '', m, table).trim(), patternIndex: i }
  }
  return { value: '', patternIndex: -1 }
}

/** The mapping-type entry point: read the source field, then extract. */
export function applyExtract(
  config: Record<string, unknown>,
  resolve: (field: string) => string
): ExtractResult {
  const cfg = config as ExtractConfig
  const input = cfg.field ? resolve(cfg.field) : ''
  return extractWithPatterns(input, cfg.patterns, cfg.lookup)
}
