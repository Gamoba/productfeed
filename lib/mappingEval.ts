// Evaluates a feed's mappings for ONE feed item (a product, or a variant in
// variant mode), including references from one mapping to another.
//
// ── Mapped feed fields ("feed:<google_field>") ─────────────────────────────
//
// Anywhere a mapping reads a field — the main function's source, a Combine
// block, an Only-if condition on either side, an ELSE value — it may name
// `feed:color` instead of a Shopify field. That reads the FINAL value this item
// gets for <g:color>: main function → Only-if branch → transforms, exactly what
// the feed emits. It's how a title can be built from colour and size that were
// themselves extracted from the URL by other mappings.
//
// Values are computed lazily and memoised per item, so a field referenced by
// three other mappings and also emitted is computed once. Rules:
//   - a reference to a field with no mapping is '' (the editor won't offer it);
//   - an AI mapping can't be referenced ('' — it costs an API call per item and
//     is resolved asynchronously by the generator);
//   - a cycle (title reads feed:size, size reads feed:title) is cut: the field
//     that closes the loop reads '' instead of recursing forever.
//
// ── Master fields ("master:<key>") ─────────────────────────────────────────
//
// A master field is a rule set up once on the shop (table master_fields,
// lib/masterFields). It is read like a `feed:` reference: `master:<key>` as a
// source anywhere, or the MASTER mapping type, which takes the whole value and
// then applies the field's own Only-if/transforms. A master field's own `feed:`
// references read the feed that uses it. Same memo and cycle rules; a master
// field that doesn't exist (or isn't loaded) reads ''.
//
// ── The accepted AI title ──────────────────────────────────────────────────
//
// An accepted AI title has always REPLACED the title mapping outright. That
// still holds, with one exception: a skip-empty Combine title mapping (the
// "title + colour + size" shape) is evaluated with the AI title standing in for
// the `title` source field, so an optimised title still gets its colour and size
// appended. Other mappings reading `title` keep seeing the Shopify title.
//
// Pure and synchronous, shared by the feed generator (server) and the mapping
// preview (client) so the two can't drift.

import { applyTransforms, stripHtml, type FindReplacePair, type Transform } from './mappingTransforms'
import { combineBlocks, selectBranchValue, type CombineBlock, type FieldResolver, type OnlyIf } from './mappingRules'
import { applyExtract } from './mappingExtract'
import { applyLookup, type LookupConfig } from './mappingLookup'

export const FEED_FIELD_PREFIX = 'feed:'
export const MASTER_FIELD_PREFIX = 'master:'

/** A shop-level master field, as the evaluator needs it. */
export type EvalMasterField = {
  key: string
  mapping_type: string
  config: Record<string, unknown>
}

export type EvalMapping = {
  google_field: string
  mapping_type: string
  config: Record<string, unknown>
}

export function isFeedFieldRef(field: string): boolean {
  return field.startsWith(FEED_FIELD_PREFIX)
}

export function isMasterFieldRef(field: string): boolean {
  return field.startsWith(MASTER_FIELD_PREFIX)
}

/** Reads another mapping's or a master field's value rather than a source field. */
export function isMappedRef(field: string): boolean {
  return isFeedFieldRef(field) || isMasterFieldRef(field)
}

/** The main function of every non-AI mapping type. AI returns null. */
export function mainValue(
  type: string,
  config: Record<string, unknown>,
  resolve: FieldResolver
): string | null {
  const field = () => resolve(String(config.field ?? ''))
  switch (type) {
    case 'FIELD':
      return field()
    case 'STATIC':
      return String(config.value ?? '')
    case 'COMBINE':
      return combineBlocks(config.blocks as CombineBlock[] | undefined, resolve, config.skipEmpty === true)
    case 'PREFIX_SUFFIX': {
      const val = field()
      if (!val) return ''
      return `${config.prefix ?? ''}${val}${config.suffix ?? ''}`
    }
    case 'FIND_REPLACE': {
      let val = field()
      for (const pair of (config.pairs as FindReplacePair[]) ?? []) {
        if (pair.find) val = val.split(pair.find).join(pair.replace)
      }
      return val
    }
    case 'TRUNCATE':
      return field().slice(0, Number(config.maxChars ?? 500))
    case 'STRIP_HTML':
      return stripHtml(field())
    case 'LOOKUP':
      return applyLookup(field(), config as LookupConfig)
    case 'EXTRACT':
      return applyExtract(config, resolve).value
    case 'MASTER':
      return config.master ? resolve(MASTER_FIELD_PREFIX + String(config.master)) : ''
    case 'AI':
      return null
    default:
      return ''
  }
}

/** Only-if branch, then transforms — the part after the main function. */
export function finishValue(
  config: Record<string, unknown>,
  base: string,
  resolve: FieldResolver
): string {
  const value = selectBranchValue(config.onlyIf as OnlyIf | undefined, base, resolve)
  return applyTransforms(value, config.transforms as Transform[] | undefined)
}

// Whether the title mapping builds on the title rather than replacing it, and
// so should run on top of an accepted AI title (see header).
function buildsOnTitle(m: EvalMapping): boolean {
  return m.mapping_type === 'COMBINE' && m.config.skipEmpty === true
}

export type ItemEvaluator = {
  /** Reads a source field or a `feed:` reference for this item. */
  resolve: FieldResolver
  /**
   * The final value of a mapped field for this item. AI mappings return
   * `aiPlaceholder` when given, else null (the caller resolves those itself).
   */
  value: (googleField: string) => string | null
  /** Branch + transforms around an externally computed base (AI mappings). */
  finish: (googleField: string, base: string) => string
}

export function createItemEvaluator(opts: {
  mappings: EvalMapping[]
  resolveSource: FieldResolver
  // Accepted AI title for this item's product, if any.
  aiTitle?: string | null
  // Returned for AI mappings by value() — the preview's "__AI__".
  aiPlaceholder?: string
  // The shop's master fields (lib/masterFields).
  masters?: EvalMasterField[]
}): ItemEvaluator {
  const { resolveSource, aiTitle, aiPlaceholder } = opts
  const byField = new Map<string, EvalMapping>()
  for (const m of opts.mappings) if (m.mapping_type) byField.set(m.google_field, m)
  // Keyed by the full reference, so they share the memo without clashing.
  const byMaster = new Map<string, EvalMapping>()
  for (const m of opts.masters ?? []) {
    if (m.mapping_type && m.mapping_type !== 'AI') {
      byMaster.set(MASTER_FIELD_PREFIX + m.key, { google_field: MASTER_FIELD_PREFIX + m.key, mapping_type: m.mapping_type, config: m.config })
    }
  }

  const memo = new Map<string, string>()
  const inProgress = new Set<string>()

  const resolve: FieldResolver = (field) => {
    if (isMasterFieldRef(field)) {
      const m = byMaster.get(field)
      return m ? (computeSync(m) ?? '') : ''
    }
    if (!isFeedFieldRef(field)) return resolveSource(field)
    const gf = field.slice(FEED_FIELD_PREFIX.length)
    const m = byField.get(gf)
    if (!m || m.mapping_type === 'AI') {
      // An AI title mapping is still readable when an AI title replaces it.
      if (gf === 'title' && aiTitle && m) return aiTitle
      return ''
    }
    return computeSync(m) ?? ''
  }

  // The title mapping evaluated on top of the AI title: same evaluator, but the
  // `title` source reads the AI title. feed: references still go through the
  // shared memo.
  const resolveWithAiTitle: FieldResolver = (field) =>
    field === 'title' && aiTitle ? aiTitle : resolve(field)

  // Set when a cycle was cut while computing the current field. A value that
  // depends on a cut is NOT memoised — otherwise the result would depend on
  // which field happened to be evaluated first.
  let cut = false

  function computeSync(m: EvalMapping): string | null {
    const gf = m.google_field
    const hit = memo.get(gf)
    if (hit !== undefined) return hit
    if (inProgress.has(gf)) {
      cut = true
      return '' // cycle — cut here
    }
    const outerCut = cut
    cut = false
    inProgress.add(gf)
    try {
      let out: string | null
      if (gf === 'title' && aiTitle && !buildsOnTitle(m)) {
        out = aiTitle
      } else if (m.mapping_type === 'AI') {
        return null // not memoised; caller handles AI
      } else {
        const r = gf === 'title' && aiTitle ? resolveWithAiTitle : resolve
        out = finishValue(m.config, mainValue(m.mapping_type, m.config, r) ?? '', r)
      }
      if (!cut) memo.set(gf, out)
      return out
    } finally {
      inProgress.delete(gf)
      cut = outerCut || cut
    }
  }

  return {
    resolve,
    value(googleField) {
      const m = byField.get(googleField)
      if (!m) return ''
      const v = computeSync(m)
      if (v === null && aiPlaceholder !== undefined) return aiPlaceholder
      return v
    },
    finish(googleField, base) {
      const m = byField.get(googleField)
      return m ? finishValue(m.config, base, resolve) : base
    },
  }
}
