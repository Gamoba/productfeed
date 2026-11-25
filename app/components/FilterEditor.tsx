'use client'

// Shared filter-editor UI — the include/exclude rule form used by both the feed
// Filters page and the AI-title optimization Scope panel. Pure presentational
// pieces (field/operator dropdowns, rule rows, AND/OR section). Evaluation /
// counting is the caller's concern (feed filters count client-side; the
// optimization scope recomputes server-side via the shared applyFeedFilters).

import type { FilterRule, FilterConfig } from '@/app/filters/actions'

// A metafield the feed actually has, for the field dropdown. When a caller
// passes these, the metafield field becomes a pick-list instead of free text;
// without them the free-text `namespace.key` input is kept (back-compat for the
// feed Filters page and the legacy scope panel).
export type MetafieldOption = { namespace: string; key: string; count: number; name?: string }

// Human-readable label for a metafield: the definition name when known
// (e.g. "Årgang"), else the raw "namespace.key". Shopify can't store non-ASCII
// in metafield keys, so a Danish field like "Årgang" lives under a mangled key
// (custom._rgang) and the definition name is the only legible form.
export function metafieldLabel(m: { namespace: string; key: string; name?: string }): string {
  const name = m.name?.trim()
  return name ? name : `${m.namespace}.${m.key}`
}

export const FILTER_FIELDS = [
  { value: 'title', label: 'Title' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'product_type', label: 'Product type' },
  { value: 'tags', label: 'Tags' },
  { value: 'status', label: 'Status' },
  { value: 'handle', label: 'Handle' },
  { value: 'variants[0].price', label: 'Price' },
  { value: 'variants[0].sku', label: 'SKU' },
  { value: 'variants[0].inventory_quantity', label: 'Stock' },
  { value: 'variants[0].barcode', label: 'Barcode' },
  { value: '__metafield__', label: 'Metafield…' },
]

export const OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: 'does_not_contain', label: 'does not contain' },
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
  { value: 'greater_than', label: 'is over' },
  { value: 'less_than', label: 'is under' },
]

export const NO_VALUE_OPS = new Set(['is_empty', 'is_not_empty'])
// Operators compared numerically — case mode is irrelevant for these.
export const NUMERIC_OPS = new Set(['greater_than', 'less_than'])

export function defaultRule(): FilterRule {
  // New rules default to case-insensitive matching (the common need); the per-rule
  // toggle can switch to "Match case". Legacy rules with no caseSensitive flag are
  // treated as case-sensitive by the matcher, preserving their behaviour.
  return { field: 'title', operator: 'contains', value: '', caseSensitive: false }
}

export function defaultConfig(): FilterConfig {
  return { operator: 'AND', rules: [] }
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export function RuleRow({
  rule,
  onChange,
  onDelete,
  metafieldOptions,
  masterOptions,
}: {
  rule: FilterRule
  onChange: (patch: Partial<FilterRule>) => void
  onDelete: () => void
  metafieldOptions?: MetafieldOption[]
  /** The shop's master fields; offered as `master:<key>` (feed rules only). */
  masterOptions?: { key: string; name: string }[]
}) {
  const isMaster = rule.field.startsWith('master:')
  const isMetafield = rule.field.startsWith('metafield:')
  const metafieldKey = isMetafield ? rule.field.slice('metafield:'.length) : ''
  const dropdownValue = isMetafield ? '__metafield__' : rule.field
  const needsValue = !NO_VALUE_OPS.has(rule.operator)
  // Case toggle is meaningful only for text comparisons (not is_(not_)empty, not
  // numeric >/<). Undefined caseSensitive ⇒ case-sensitive (legacy default).
  const showCaseToggle = needsValue && !NUMERIC_OPS.has(rule.operator)

  function handleFieldSelect(val: string) {
    if (val === '__metafield__') onChange({ field: 'metafield:' })
    else onChange({ field: val })
  }

  const selectCls = 'ff-select'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={dropdownValue}
        onChange={(e) => handleFieldSelect(e.target.value)}
        className={`${selectCls} w-44 shrink-0`}
      >
        {FILTER_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>{f.label}</option>
        ))}
        {isMaster && !masterOptions?.some((m) => `master:${m.key}` === rule.field) && (
          <option value={rule.field}>
            {rule.field.slice('master:'.length)} (no longer exists)
          </option>
        )}
        {masterOptions && masterOptions.length > 0 && (
          <optgroup label="Master fields">
            {masterOptions.map((m) => (
              <option key={m.key} value={`master:${m.key}`}>
                {m.name} (master)
              </option>
            ))}
          </optgroup>
        )}
      </select>

      {isMetafield && (
        metafieldOptions ? (
          <select
            value={metafieldKey}
            onChange={(e) => onChange({ field: `metafield:${e.target.value}` })}
            className={`${selectCls} w-48 shrink-0`}
          >
            <option value="">Choose metafield…</option>
            {/* If a saved value isn't among the feed's current metafields, keep it
                selectable so editing an existing rule doesn't silently drop it. */}
            {metafieldKey && !metafieldOptions.some((m) => `${m.namespace}.${m.key}` === metafieldKey) && (
              <option value={metafieldKey}>{metafieldKey} (not in the feed)</option>
            )}
            {metafieldOptions.map((m) => {
              const k = `${m.namespace}.${m.key}`
              return <option key={k} value={k}>{metafieldLabel(m)} ({m.count})</option>
            })}
          </select>
        ) : (
          <input
            type="text"
            value={metafieldKey}
            onChange={(e) => onChange({ field: `metafield:${e.target.value}` })}
            placeholder="namespace.key"
            className={`${selectCls} w-36 shrink-0`}
          />
        )
      )}

      <select
        value={rule.operator}
        onChange={(e) => onChange({ operator: e.target.value })}
        className={`${selectCls} w-44 shrink-0`}
      >
        {OPERATORS.map((op) => (
          <option key={op.value} value={op.value}>{op.label}</option>
        ))}
      </select>

      {needsValue ? (
        <input
          type="text"
          value={rule.value}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="Value…"
          className={`${selectCls} flex-1 min-w-24`}
        />
      ) : (
        <div className="flex-1" />
      )}

      {showCaseToggle && (
        <select
          value={(rule.caseSensitive ?? true) ? 'cs' : 'ci'}
          onChange={(e) => onChange({ caseSensitive: e.target.value === 'cs' })}
          className={`${selectCls} w-32 shrink-0`}
          title="Whether upper and lower case must match"
        >
          <option value="ci">Ignore case</option>
          <option value="cs">Match case</option>
        </select>
      )}

      <button
        type="button"
        onClick={onDelete}
        className="ff-btn-ghost shrink-0 w-6 h-6"
        aria-label="Delete rule"
      >
        <XIcon />
      </button>
    </div>
  )
}

export function FilterSection({
  title,
  description,
  badge,
  badgeCls,
  config,
  onAddRule,
  onRemoveRule,
  onUpdateRule,
  onSetOperator,
  metafieldOptions,
}: {
  title: string
  description: string
  badge: string
  badgeCls: string
  config: FilterConfig
  onAddRule: () => void
  onRemoveRule: (i: number) => void
  onUpdateRule: (i: number, patch: Partial<FilterRule>) => void
  onSetOperator: (op: 'AND' | 'OR') => void
  metafieldOptions?: MetafieldOption[]
}) {
  return (
    <div className="ff-panel">
      <div
        className="ff-panel-header"
        style={{ textTransform: 'none', letterSpacing: 0, fontSize: '11px', alignItems: 'flex-start', padding: '10px 14px' }}
      >
        <div className="flex items-start gap-2.5">
          <span className={`mt-0.5 shrink-0 ${badgeCls}`}>{badge}</span>
          <div>
            <h2 style={{ fontSize: '12px', fontWeight: 500, color: 'var(--ink)' }}>{title}</h2>
            <p className="mt-0.5" style={{ fontSize: '10px', color: 'var(--ink-muted)', textTransform: 'none', letterSpacing: 0 }}>{description}</p>
          </div>
        </div>
      </div>

      <div className="p-3.5">
        {config.rules.length === 0 ? (
          <p className="text-center py-3" style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
            No rules yet. Add one below.
          </p>
        ) : (
          <div className="space-y-1">
            {config.rules.map((rule, i) => (
              <div key={i}>
                {i > 0 && (
                  <div className="flex items-center gap-2 my-2">
                    <div className="flex-1 h-px" style={{ background: 'var(--hairline)' }} />
                    <div
                      className="inline-flex overflow-hidden"
                      style={{ border: '1px solid var(--hairline)', borderRadius: '4px' }}
                    >
                      {(['AND', 'OR'] as const).map((op, j) => (
                        <button
                          key={op}
                          onClick={() => onSetOperator(op)}
                          style={{
                            padding: '3px 9px',
                            fontSize: '10px',
                            fontWeight: 600,
                            letterSpacing: '0.4px',
                            borderLeft: j > 0 ? '1px solid var(--hairline)' : 'none',
                            background: config.operator === op ? 'var(--dark)' : 'transparent',
                            color: config.operator === op ? 'var(--dark-fg)' : 'var(--ink-muted)',
                          }}
                        >
                          {op}
                        </button>
                      ))}
                    </div>
                    <div className="flex-1 h-px" style={{ background: 'var(--hairline)' }} />
                  </div>
                )}
                <RuleRow
                  rule={rule}
                  onChange={(p) => onUpdateRule(i, p)}
                  onDelete={() => onRemoveRule(i)}
                  metafieldOptions={metafieldOptions}
                />
              </div>
            ))}
          </div>
        )}

        <button
          onClick={onAddRule}
          className="mt-3 flex items-center gap-1.5 transition-colors"
          style={{ fontSize: '12px', fontWeight: 500, color: 'var(--accent-ink)' }}
        >
          <PlusIcon />
          Add rule
        </button>
      </div>
    </div>
  )
}
