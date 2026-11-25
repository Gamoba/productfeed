// The conditional part of a feed mapping: conditions, the ordered rule list,
// and the fallback.
//
// Shared by the feed generator (server, resolving against a SupabaseProduct)
// and the mapping preview (client, resolving against the lighter PreviewProduct
// shape). The only thing that differs between the two is HOW a field token is
// read, so everything here takes a `resolve(field) => string` callback and the
// two callers pass their own. That keeps one copy of the operator table and one
// copy of the priority logic — previously there were two, and they had to be
// kept in sync by hand.
//
// ── The shape, and why it grew ──────────────────────────────────────────────
//
// A mapping used to be a two-way choice: the mapping's own value when the
// conditions held, otherwise a single `else`. That caps a field at two possible
// outputs. `rules` adds any number of branches in between:
//
//   ONLY IF  <conditions>        → the mapping's own value   (branch 0)
//   ELSE IF  <rules[0].conditions> → rules[0].value
//   ELSE IF  <rules[1].conditions> → rules[1].value
//   ELSE                          → else
//
// Evaluation is strictly top-down and stops at the FIRST branch that matches —
// so the list is a priority order, and a broad rule placed above a narrow one
// shadows it. `rules` is optional; a config without it behaves exactly as
// before, which is what keeps every saved mapping working untouched.

// `skipIfPresent` (field blocks only): leave this block out when the text built
// so far already contains its value as a whole word, ignoring case — "add the
// colour to the title unless the title already says it".
export type CombineBlock = { type: 'field' | 'text'; value: string; skipIfPresent?: boolean }

export type Condition = {
  field: string
  operator: string
  value: string
  logic: 'AND' | 'OR' | null
  // Text comparisons only. Undefined = case-sensitive, which is how every
  // condition saved before this existed behaved; the editor sets false
  // ("Ignore case") on new conditions. Same convention as feed filters.
  caseSensitive?: boolean
}

// The four ways a branch can produce a value. `empty` / `static` / `field` use
// `value`; `combine` reuses the same block list as a top-level COMBINE mapping
// (and the same `skipEmpty` switch — see combineBlocks).
export type ValueSpec =
  | { type: 'empty' | 'static' | 'field'; value: string }
  | { type: 'combine'; blocks: CombineBlock[]; skipEmpty?: boolean }

export type Rule = { conditions: Condition[]; value: ValueSpec }

export type OnlyIf = {
  conditions: Condition[]
  // Extra branches between the primary condition and the fallback, in priority
  // order. Optional — absent on every mapping saved before this existed.
  rules?: Rule[]
  else: ValueSpec
}

export type FieldResolver = (field: string) => string

// ── Condition evaluation ───────────────────────────────────────────────────

// ── Whole-word matching ────────────────────────────────────────────────────

// Plain `includes` is useless for short values: size "L" is "contained" in
// "Full", colour "Sort" in "Sortiment". A word match requires the needle to
// stand on its own — no letter or digit directly before or after it — so
// "36/37", "Dark Blue" and "L" all match as written and nothing inside a word.
const wordReCache = new Map<string, RegExp>()

function wordRegex(needle: string, ignoreCase: boolean): RegExp {
  const key = `${ignoreCase ? 'i' : '-'}:${needle}`
  let re = wordReCache.get(key)
  if (!re) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, ignoreCase ? 'iu' : 'u')
    if (wordReCache.size >= 1000) wordReCache.clear()
    wordReCache.set(key, re)
  }
  return re
}

/** Whether `needle` occurs in `haystack` as a whole word. An empty needle never does. */
export function containsWord(haystack: string, needle: string, ignoreCase: boolean): boolean {
  const n = needle.trim()
  if (!n || !haystack) return false
  return wordRegex(n, ignoreCase).test(haystack)
}

// ── Condition evaluation ───────────────────────────────────────────────────

// Every text operator has a `<op>_field` twin whose right-hand side is another
// field's value instead of a literal (e.g. price less_than_field
// compare_at_price for sale detection, title not_contains_word_field
// feed:color). The suffix is stripped once and the same table serves both.
export function evalCondition(cond: Condition, resolve: FieldResolver): boolean {
  const op = cond.operator ?? ''
  const isField = op.endsWith('_field')
  const base = isField ? op.slice(0, -'_field'.length) : op
  const rawL = resolve(cond.field)
  const rawR = isField ? resolve(cond.value) : (cond.value ?? '')
  const ignoreCase = cond.caseSensitive === false
  const l = ignoreCase ? rawL.toLowerCase() : rawL
  const r = ignoreCase ? rawR.toLowerCase() : rawR
  switch (base) {
    case 'equals':            return l === r
    case 'not_equals':        return l !== r
    case 'contains':          return l.includes(r)
    case 'not_contains':      return !l.includes(r)
    case 'starts_with':       return l.startsWith(r)
    case 'ends_with':         return l.endsWith(r)
    case 'contains_word':     return containsWord(rawL, rawR, ignoreCase)
    case 'not_contains_word': return !containsWord(rawL, rawR, ignoreCase)
    case 'greater_than':      return parseFloat(rawL) > parseFloat(rawR)
    case 'less_than':         return parseFloat(rawL) < parseFloat(rawR)
    case 'is_empty':          return !rawL
    case 'is_not_empty':      return !!rawL
    default:                  return true
  }
}

// Left-to-right, no precedence between AND and OR — the same flat evaluation
// the UI presents (each row's connector applies to the running result).
export function evaluateConditions(conditions: Condition[], resolve: FieldResolver): boolean {
  if (!conditions.length) return true
  let result = evalCondition(conditions[0], resolve)
  for (let i = 1; i < conditions.length; i++) {
    const val = evalCondition(conditions[i], resolve)
    result = conditions[i].logic === 'OR' ? result || val : result && val
  }
  return result
}

// ── Value resolution ───────────────────────────────────────────────────────

/**
 * Joins Combine blocks into one string.
 *
 * With `skipEmpty` off (every Combine saved before the option existed) blocks
 * are concatenated as written.
 *
 * With `skipEmpty` on, text blocks act as separators that belong to the field
 * AFTER them: `[title][" – "][color][" – "][size]`
 *   - an empty field takes the text in front of it along with it
 *       color empty → "Title – L", both empty → "Title"
 *   - a separator never starts the result: when the first field(s) are empty,
 *     the text before the first value that IS emitted is dropped too
 *       `[color][" – "][size]`, color empty → "L" (not " – L")
 *     — unless no field came before it at all, i.e. it's a real prefix
 *   - text after the last field is kept only when something was emitted
 *   - runs of spaces collapse to one and the ends are trimmed.
 *
 * `skipIfPresent` on a field block treats it as empty when the text built so far
 * already contains its value as a whole word (ignoring case), so it disappears
 * with its separator. Applied in both modes.
 */
export function combineBlocks(
  blocks: CombineBlock[] | undefined,
  resolve: FieldResolver,
  skipEmpty = false
): string {
  const list = Array.isArray(blocks) ? blocks : []
  if (!skipEmpty) {
    let out = ''
    for (const b of list) {
      if (b.type !== 'field') { out += b.value ?? ''; continue }
      const v = b.value ? resolve(b.value) : ''
      out += b.skipIfPresent && containsWord(out, v, true) ? '' : v
    }
    return out
  }

  let out = ''
  let pending = '' // text waiting for the next field to decide its fate
  let sawField = false
  for (const b of list) {
    if (b.type !== 'field') { pending += b.value ?? ''; continue }
    let v = b.value ? resolve(b.value) : ''
    if (v.trim() && b.skipIfPresent && containsWord(out, v, true)) v = ''
    if (!v.trim()) {
      pending = ''
      sawField = true
      continue
    }
    if (out || !sawField) out += pending
    out += v
    pending = ''
    sawField = true
  }
  if (out || !sawField) out += pending
  return out.replace(/[ \t ]{2,}/g, ' ').trim()
}

export function resolveValueSpec(spec: ValueSpec | undefined, resolve: FieldResolver): string {
  if (!spec) return ''
  switch (spec.type) {
    case 'static': return spec.value ?? ''
    case 'field':  return spec.value ? resolve(spec.value) : ''
    case 'combine': return combineBlocks(spec.blocks, resolve, !!spec.skipEmpty)
    default: return ''
  }
}

// A rule only counts once it names a field to test. Without this an ELSE IF
// that the user has added but not filled in yet would evaluate `'' equals ''`
// → true, swallow every product, and shadow the fallback below it.
function ruleIsActive(rule: Rule | undefined): rule is Rule {
  return !!rule && Array.isArray(rule.conditions) && rule.conditions.some((c) => c.field)
}

// Picks the branch for one product. `baseValue` is what the mapping's own
// function produced — it is branch 0, used when the primary conditions hold (or
// when there are no conditions at all).
export function selectBranchValue(
  onlyIf: OnlyIf | undefined,
  baseValue: string,
  resolve: FieldResolver
): string {
  if (!onlyIf?.conditions?.length) return baseValue
  if (evaluateConditions(onlyIf.conditions, resolve)) return baseValue

  for (const rule of onlyIf.rules ?? []) {
    if (!ruleIsActive(rule)) continue
    if (evaluateConditions(rule.conditions, resolve)) {
      return resolveValueSpec(rule.value, resolve)
    }
  }

  return resolveValueSpec(onlyIf.else, resolve)
}

// Every field token a rule list references — the conditions' left-hand fields,
// their field-mode right-hand sides, and any field used by a branch's value.
// Feeds the "mapped / not mapped" badges in the Shopify-fields panel.
export function collectRuleFields(onlyIf: OnlyIf | undefined): string[] {
  if (!onlyIf) return []
  const out: string[] = []

  const fromConditions = (conditions: Condition[] | undefined) => {
    for (const c of conditions ?? []) {
      if (c.field) out.push(c.field)
      if (c.operator?.endsWith('_field') && c.value) out.push(c.value)
    }
  }
  const fromValue = (spec: ValueSpec | undefined) => {
    if (!spec) return
    if (spec.type === 'field' && spec.value) out.push(spec.value)
    if (spec.type === 'combine') {
      for (const b of spec.blocks ?? []) if (b.type === 'field' && b.value) out.push(b.value)
    }
  }

  fromConditions(onlyIf.conditions)
  for (const rule of onlyIf.rules ?? []) {
    fromConditions(rule.conditions)
    fromValue(rule.value)
  }
  fromValue(onlyIf.else)

  return out
}
