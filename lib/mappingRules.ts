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

export type CombineBlock = { type: 'field' | 'text'; value: string }

export type Condition = {
  field: string
  operator: string
  value: string
  logic: 'AND' | 'OR' | null
}

// The four ways a branch can produce a value. `empty` / `static` / `field` use
// `value`; `combine` reuses the same block list as a top-level COMBINE mapping.
export type ValueSpec =
  | { type: 'empty' | 'static' | 'field'; value: string }
  | { type: 'combine'; blocks: CombineBlock[] }

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

export function evalCondition(cond: Condition, resolve: FieldResolver): boolean {
  const v = resolve(cond.field)
  switch (cond.operator) {
    case 'equals':       return v === cond.value
    case 'not_equals':   return v !== cond.value
    case 'contains':     return v.includes(cond.value)
    case 'not_contains': return !v.includes(cond.value)
    case 'starts_with':  return v.startsWith(cond.value)
    case 'ends_with':    return v.endsWith(cond.value)
    case 'greater_than': return parseFloat(v) > parseFloat(cond.value)
    case 'less_than':    return parseFloat(v) < parseFloat(cond.value)
    case 'is_empty':     return !v
    case 'is_not_empty': return !!v
    // *_field variants resolve the RHS as a field reference instead of a
    // literal — used by the default mappings that compare two product fields
    // (e.g. price < compare_at_price for sale detection).
    case 'less_than_field':    return parseFloat(v) < parseFloat(resolve(cond.value))
    case 'greater_than_field': return parseFloat(v) > parseFloat(resolve(cond.value))
    case 'equals_field':       return v === resolve(cond.value)
    case 'not_equals_field':   return v !== resolve(cond.value)
    default:             return true
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

export function resolveValueSpec(spec: ValueSpec | undefined, resolve: FieldResolver): string {
  if (!spec) return ''
  switch (spec.type) {
    case 'static': return spec.value ?? ''
    case 'field':  return spec.value ? resolve(spec.value) : ''
    case 'combine':
      return (spec.blocks ?? [])
        .map((b) => (b.type === 'field' ? resolve(b.value) : b.value))
        .join('')
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
