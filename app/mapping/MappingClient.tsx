'use client'

import { createContext, useContext, useEffect, useMemo, useState, useTransition } from 'react'
import { saveMappings, type MappingEntry } from './actions'
import {
  configTransforms,
  TRANSFORM_LABELS,
  type Transform,
  type TransformType,
} from '@/lib/mappingTransforms'
import {
  collectRuleFields,
  type CombineBlock,
  type Condition,
  type OnlyIf,
  type Rule,
  type ValueSpec,
} from '@/lib/mappingRules'
import { parseLookupPaste, type LookupConfig, type LookupRow } from '@/lib/mappingLookup'
import './mapping.css'
import { Icon, type IconName } from '../components/shell/icons'
import { ADVANCED_CATEGORIES, COLLAPSIBLE_SECTIONS, REQUIRED_FIELDS, STANDARD_FIELDS } from '@/lib/mappingFields'
import {
  applyExtract,
  patternError,
  type ExtractPattern,
  type LookupEntry,
} from '@/lib/mappingExtract'
import { markFeedEdited } from '@/lib/recentEdit'
import {
  createItemEvaluator,
  FEED_FIELD_PREFIX,
  isFeedFieldRef,
  type EvalMapping,
  type ItemEvaluator,
} from '@/lib/mappingEval'

// Lets all FieldSelect / ShopifyFieldsModal usages pick up the active feed
// mode without prop-drilling through 8+ render sites.
const FeedModeContext = createContext<'product' | 'variant'>('product')

// Maps a metafield token ("metafield:custom._rgang") to its readable definition
// name ("Årgang"). Shopify mangles non-ASCII keys, so the raw key is illegible;
// the name lives in the metafield definition (resolved server-side). Provided
// via context so the deep field pickers can show it without prop-drilling.
// Missing entries fall back to the raw key.
const MetafieldLabelsContext = createContext<Map<string, string>>(new Map())

// Page-level state a config editor may need without prop-drilling through
// FieldRow / SectionPanel / CustomFieldsSection.
const EditorContext = createContext<{
  feedId: string
  previewProduct: PreviewProduct | null
  marketUrl: string | null
}>({ feedId: '', previewProduct: null, marketUrl: null })

// The whole editor state (google_field → mapping). Feeds the "Feed fields
// (mapped)" group in every field picker and the previews that resolve
// `feed:<field>` references.
const MappingsContext = createContext<Record<string, FieldState>>({})

// The google_field whose editor is rendering — a field picker inside it leaves
// that field out of "Feed fields (mapped)" so a mapping can't read itself.
const CurrentFieldContext = createContext<string>('')

// Readable label for a "metafield:ns.key" token: the definition name when known,
// else the raw "ns.key" (the token minus its "metafield:" prefix).
function metafieldDisplayName(token: string, labels: Map<string, string>): string {
  return labels.get(token) ?? token.replace('metafield:', '')
}

// ── Types ──────────────────────────────────────────────────────────────────

type MappingType =
  | ''
  | 'FIELD'
  | 'STATIC'
  | 'COMBINE'
  | 'PREFIX_SUFFIX'
  | 'FIND_REPLACE'
  | 'TRUNCATE'
  | 'STRIP_HTML'
  | 'LOOKUP'
  | 'EXTRACT'
  | 'AI'

type Config = Record<string, unknown>
type FieldState = { type: MappingType; config: Config }

type AISuggestion = {
  google_field: string
  shopify_field: string | null
  mapping_type: 'field' | 'static'
  static_value?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

// ── Static data ────────────────────────────────────────────────────────────

// Required Google Shopping fields — always visible, top of the page, never collapsed.
const REQUIRED_SET = new Set<string>(REQUIRED_FIELDS)
const WIDE_EDITORS = new Set<string>(['EXTRACT', 'LOOKUP'])

// Filter chips above the field list.
type FieldChip = 'all' | 'unmapped' | 'rules' | 'lookup' | 'ai'
const FIELD_CHIPS: { id: FieldChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unmapped', label: 'Not mapped' },
  { id: 'rules', label: 'With rules' },
  { id: 'lookup', label: 'Lookup' },
  { id: 'ai', label: 'AI' },
]

// The icon in front of a field name says what kind of field it is.
function fieldIcon(field: string): IconName {
  if (/image|media/.test(field)) return 'image'
  if (/link|url/.test(field)) return 'link'
  if (/price|cost/.test(field)) return 'price'
  if (/shipping|handling/.test(field)) return 'truck'
  if (/^(id|gtin|mpn|item_group_id|identifier_exists|promotion_id)$/.test(field)) return 'hash'
  if (/custom_label/.test(field)) return 'tag'
  if (/category|product_type/.test(field)) return 'feeds'
  if (/availability|condition|stock/.test(field)) return 'box'
  return 'text'
}

// Collapsible sections — collapsed by default, auto-opened when at least one
// field inside has a saved mapping.
const COLLAPSIBLE_FIELDS = COLLAPSIBLE_SECTIONS.flatMap((s) => s.fields)
const ADVANCED_FIELDS = ADVANCED_CATEGORIES.flatMap((c) => c.fields)

// Every field the mapping UI knows about — used for state initialisation,
// AI-suggestion validation and the save serialisation.
const ALL_FIELDS = [...REQUIRED_FIELDS, ...COLLAPSIBLE_FIELDS, ...ADVANCED_FIELDS]



const MAPPING_TYPES: { value: MappingType; label: string }[] = [
  { value: '', label: '— Not mapped —' },
  { value: 'FIELD', label: 'Field' },
  { value: 'STATIC', label: 'Static' },
  { value: 'COMBINE', label: 'Combine' },
  { value: 'PREFIX_SUFFIX', label: 'Prefix / Suffix' },
  { value: 'FIND_REPLACE', label: 'Find & replace' },
  { value: 'TRUNCATE', label: 'Truncate' },
  { value: 'STRIP_HTML', label: 'Strip HTML' },
  { value: 'LOOKUP', label: 'Lookup table' },
  { value: 'EXTRACT', label: 'Extract with pattern' },
  { value: 'AI', label: 'AI' },
]

const OPERATORS = [
  { value: 'equals', label: '= equals' },
  { value: 'not_equals', label: '≠ does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  // Whole word: "L" doesn't match inside "Full" — use these for sizes/colours.
  { value: 'contains_word', label: 'contains word' },
  { value: 'not_contains_word', label: 'does not contain word' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'greater_than', label: '> greater than' },
  { value: 'less_than', label: '< less than' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
]

const NO_VALUE_OPERATORS = ['is_empty', 'is_not_empty']

// Operators that have a "_field" variant in the resolver — i.e. the RHS can
// be either a literal value or another product-field reference. Used to
// decide whether the Værdi / Felt toggle is shown.
const MODE_AWARE_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'contains_word',
  'not_contains_word',
  'starts_with',
  'ends_with',
  'greater_than',
  'less_than',
])

// Operators where upper/lower case can matter (the "Aa" toggle). Numeric and
// emptiness checks ignore it.
const CASE_AWARE_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'contains_word',
  'not_contains_word',
  'starts_with',
  'ends_with',
])

// A fresh condition row. New rows ignore case — the common need; rows saved
// before the option existed have no flag and stay case-sensitive.
function newCondition(logic: Condition['logic']): Condition {
  return { field: '', operator: 'equals', value: '', logic, caseSensitive: false }
}

// Strips the "_field" suffix so the dropdown can render and select a single
// option for both `less_than` and `less_than_field`.
function baseOperator(op: string): string {
  return op.endsWith('_field') ? op.slice(0, -'_field'.length) : op
}
function isFieldOperator(op: string): boolean {
  return op.endsWith('_field')
}
// Build the effective stored operator from a base + mode. Non-mode-aware
// operators ignore the field mode and stay as their base form.
function withOperatorMode(base: string, mode: 'value' | 'field'): string {
  if (mode === 'field' && MODE_AWARE_OPERATORS.has(base)) return `${base}_field`
  return base
}

// ── Shared styles ──────────────────────────────────────────────────────────

const sel = 'ff-select'
const inp = 'ff-input'
const inpSm = 'ff-input'
const btnSm =
  'px-2 py-1 rounded text-[11px] font-medium transition-colors border border-[var(--hairline)] bg-white text-[var(--ink-secondary)] hover:bg-[var(--bg-surface)]'
const miniSel = 'ff-select shrink-0'
// Left-hand keyword column of a rule row (ONLY IF / ELSE IF / THEN / ELSE).
// Fixed width so every keyword lines up down the panel.
const condLbl = 'text-xs text-[var(--muted)] opacity-70 font-mono w-16 shrink-0 pt-2'

// Drops one key from a mapping config. Used when a whole layer (the rule stack,
// the filter layer) is removed — the key must disappear rather than be left as
// an empty object, so the saved config stays clean.
function withoutKey(config: Config, key: string): Config {
  const next = { ...config }
  delete next[key]
  return next
}

// ── Live preview: client-side resolver ────────────────────────────────────

type PreviewProduct = {
  id: number
  title: string
  vendor: string
  handle: string
  body_html: string
  product_type: string
  tags: string
  status: string
  created_at: string
  updated_at: string
  published_at: string | null
  variants: Record<string, unknown>[]
  images: Record<string, unknown>[]
  metafields: { namespace: string; key: string; value: string; type: string }[]
  collections: string[]
  // Full product URL from a feed-URL source; absent/null for Shopify products.
  link?: string | null
}

// `marketUrl` may be a subdomain (https://shop.fr) or a subfolder (https://shop.com/fr) —
// in both cases we strip a trailing slash and append /products/<handle>.
//
// Mirrors buildProductUrl in lib/feedFilters.ts, including the absence of an env
// fallback: NEXT_PUBLIC_SHOP_DOMAIN is one global value, so using it here showed
// a preview link to a different merchant's store. No base URL means no link.
function buildClientProductUrl(handle: string | null | undefined, marketUrl: string | null): string {
  if (!handle || !marketUrl) return ''
  return `${marketUrl.replace(/\/+$/, '')}/products/${handle}`
}

function resolveClientField(
  field: string,
  product: PreviewProduct,
  marketUrl: string | null,
  feedMode: 'product' | 'variant' = 'product'
): string {
  if (!field) return ''

  if (field === 'url') {
    // Mirrors resolveField: a feed-URL source's own link wins.
    if (product.link) return product.link
    return buildClientProductUrl(product.handle, marketUrl)
  }

  // The bare "id" source field mirrors what the feed generator auto-injects
  // for <g:id>: shopify_id alone in product mode, shopify_id + "_" +
  // variant_id in variant mode (using the first variant for preview).
  if (field === 'id') {
    if (feedMode === 'variant') {
      const firstVariantId = product.variants[0]?.id
      return firstVariantId !== undefined && firstVariantId !== null
        ? `${product.id}_${firstVariantId}`
        : String(product.id)
    }
    return String(product.id)
  }

  // item_group_id is the renamed source-field name; shopify_id stays as a
  // back-compat alias for mappings saved before the rename. Both always
  // resolve to the product-level Shopify ID, regardless of feed mode.
  if (field === 'item_group_id' || field === 'shopify_id') {
    return String(product.id)
  }

  if (field.startsWith('metafield:')) {
    const rest = field.slice('metafield:'.length)
    const dot = rest.indexOf('.')
    if (dot === -1) return ''
    const ns = rest.slice(0, dot)
    const key = rest.slice(dot + 1)
    return product.metafields.find((m) => m.namespace === ns && m.key === key)?.value ?? ''
  }

  const variantMatch = field.match(/^variants\[(\d+)\]\.(.+)$/)
  if (variantMatch) {
    return String(product.variants[+variantMatch[1]]?.[variantMatch[2]] ?? '')
  }

  const imageMatch = field.match(/^images\[(\d+)\]\.(.+)$/)
  if (imageMatch) {
    return String(product.images[+imageMatch[1]]?.[imageMatch[2]] ?? '')
  }

  const val = (product as Record<string, unknown>)[field]
  if (val === null || val === undefined) return ''
  if (Array.isArray(val)) return val.join(', ')
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

// The preview's AI placeholder. It is not a real value, so the rule layer and
// the transform layer both step around it — otherwise "Truncate to 20" would
// render "__AI__" chopped in half.
const AI_PLACEHOLDER = '__AI__'

// One evaluator per preview product, over the CURRENT (unsaved) editor state —
// the same lib/mappingEval code the generator runs, so `feed:color` in a title
// Combine previews exactly as it will be emitted. AI mappings show the
// placeholder; an accepted AI title isn't known client-side, so the preview
// shows the mapping as if there were none.
function previewEvaluator(
  all: Record<string, FieldState>,
  product: PreviewProduct,
  marketUrl: string | null,
  feedMode: 'product' | 'variant'
): ItemEvaluator {
  const mappings: EvalMapping[] = []
  for (const [google_field, s] of Object.entries(all)) {
    if (s?.type) mappings.push({ google_field, mapping_type: s.type, config: s.config })
  }
  return createItemEvaluator({
    mappings,
    resolveSource: (f) => resolveClientField(f, product, marketUrl, feedMode),
    aiPlaceholder: AI_PLACEHOLDER,
  })
}

function computePreviewValue(
  field: string,
  all: Record<string, FieldState>,
  product: PreviewProduct,
  marketUrl: string | null,
  feedMode: 'product' | 'variant'
): string {
  if (!all[field]?.type) return ''
  return previewEvaluator(all, product, marketUrl, feedMode).value(field) ?? ''
}

// ── FieldSelect ────────────────────────────────────────────────────────────

// Source-field labels for the dropdown. A handful of variant fields read
// differently in product vs variant mode (e.g. "Pris" vs "Variant pris"),
// so this is a function rather than a static record.
function getFieldLabels(feedMode: 'product' | 'variant'): Record<string, string> {
  const isVariant = feedMode === 'variant'
  return {
    url: 'url (full product URL)',
    item_group_id: 'Product ID (item_group_id)',
    'variants[0].id': 'Variant ID',
    'variants[0].price': isVariant ? 'Variant price' : 'Price',
    'variants[0].currency': 'Currency',
    'variants[0].sku': isVariant ? 'Variant SKU' : 'SKU',
    'variants[0].barcode': isVariant ? 'Variant barcode/GTIN' : 'Barcode/GTIN',
    'variants[0].inventory_quantity': isVariant ? 'Variant stock' : 'Stock',
  }
}

// "feed:color" → "color (feed)"; custom fields read without their prefix.
function feedFieldLabel(token: string): string {
  return `${token.slice(FEED_FIELD_PREFIX.length).replace(/^custom:/, '')} (feed)`
}

// `feed:` tokens for every mapped field a picker may offer: not the field being
// edited (it can't read itself) and not AI mappings (they aren't computed per
// item without an API call, so they read as empty).
function useMappedFeedFields(): string[] {
  const all = useContext(MappingsContext)
  const current = useContext(CurrentFieldContext)
  return useMemo(
    () =>
      Object.entries(all)
        .filter(([f, s]) => s?.type && s.type !== 'AI' && f !== current)
        .map(([f]) => `${FEED_FIELD_PREFIX}${f}`)
        .sort(),
    [all, current]
  )
}

function FieldSelect({
  value,
  onChange,
  allFields,
}: {
  value: string
  onChange: (v: string) => void
  allFields: string[]
}) {
  const feedMode = useContext(FeedModeContext)
  const metafieldLabels = useContext(MetafieldLabelsContext)
  const labels = useMemo(() => getFieldLabels(feedMode), [feedMode])
  const standard = allFields.filter((f) => !f.startsWith('metafield:'))
  const meta = allFields.filter((f) => f.startsWith('metafield:'))
  const feedFields = useMappedFeedFields()
  // A saved value that isn't among the options yet — metafields still loading,
  // or a feed field that has since been unmapped — must still show, or the
  // select renders "— Select field —" and touching it would overwrite the value.
  const known =
    !value || standard.includes(value) || meta.includes(value) || feedFields.includes(value)
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={sel}>
      <option value="">— Select field —</option>
      {!known && (
        <option value={value}>
          {isFeedFieldRef(value)
            ? `${feedFieldLabel(value)} (not mapped)`
            : value.startsWith('metafield:')
              ? metafieldDisplayName(value, metafieldLabels)
              : labels[value] ?? value}
        </option>
      )}
      {feedFields.length > 0 && (
        <optgroup label="Feed fields (mapped)">
          {feedFields.map((f) => (
            <option key={f} value={f}>{feedFieldLabel(f)}</option>
          ))}
        </optgroup>
      )}
      <optgroup label="Shopify fields">
        {standard.map((f) => (
          <option key={f} value={f}>{labels[f] ?? f}</option>
        ))}
      </optgroup>
      {meta.length > 0 && (
        <optgroup label="Metafields">
          {meta.map((f) => (
            <option key={f} value={f}>{metafieldDisplayName(f, metafieldLabels)}</option>
          ))}
        </optgroup>
      )}
    </select>
  )
}

// ── CombineChipsEditor (chip-based COMBINE UI) ─────────────────────────────

function CombineChipsEditor({
  blocks,
  allFields,
  onChange,
  skipEmpty,
  onSkipEmptyChange,
}: {
  blocks: CombineBlock[]
  allFields: string[]
  onChange: (next: CombineBlock[]) => void
  // lib/mappingRules.combineBlocks: an empty field drops the text in front of it.
  skipEmpty: boolean
  onSkipEmptyChange: (v: boolean) => void
}) {
  const feedMode = useContext(FeedModeContext)
  const metafieldLabels = useContext(MetafieldLabelsContext)
  const labels = useMemo(() => getFieldLabels(feedMode), [feedMode])
  const [picker, setPicker] = useState<'none' | 'field' | 'text'>('none')
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null)
  // Drop indicator state — which chip and which side of it the dragged item
  // would land on. The visual is a thin vertical accent line at that edge.
  const [dropZone, setDropZone] = useState<{ idx: number; side: 'left' | 'right' } | null>(null)

  function addField(value: string) {
    onChange([...blocks, { type: 'field', value }])
    setPicker('none')
  }
  function addText(value: string) {
    if (!value) return
    onChange([...blocks, { type: 'text', value }])
    setPicker('none')
  }
  function removeBlock(i: number) {
    onChange(blocks.filter((_, j) => j !== i))
  }
  function toggleSkipIfPresent(i: number) {
    onChange(
      blocks.map((b, j) => {
        if (j !== i) return b
        if (b.skipIfPresent) {
          const next = { ...b }
          delete next.skipIfPresent
          return next
        }
        return { ...b, skipIfPresent: true }
      })
    )
  }

  // HTML5 DnD. dataTransfer.setData is required for Firefox to fire drop.
  function onDragStart(e: React.DragEvent, i: number) {
    setDraggedIdx(i)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(i))
  }
  function onDragOver(e: React.DragEvent, i: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (draggedIdx === null || draggedIdx === i) {
      setDropZone(null)
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side: 'left' | 'right' = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right'
    setDropZone({ idx: i, side })
  }
  function onDrop(e: React.DragEvent, target: number) {
    e.preventDefault()
    const from = draggedIdx
    const zone = dropZone
    setDraggedIdx(null)
    setDropZone(null)
    if (from === null) return
    // Insert position based on which side of the target the cursor was on:
    //   left  → at target index (target shifts right)
    //   right → after target (target stays put)
    // Then adjust for the splice removing the source item before it inserts:
    // if the source was earlier than the insertion point, the index shifts
    // by one. No-ops collapse to a no-op.
    const side = zone?.side ?? 'right'
    const insertAt = side === 'left' ? target : target + 1
    const adjusted = from < insertAt ? insertAt - 1 : insertAt
    if (adjusted === from) return
    const next = [...blocks]
    const [moved] = next.splice(from, 1)
    next.splice(adjusted, 0, moved)
    onChange(next)
  }
  function onDragEnd() {
    setDraggedIdx(null)
    setDropZone(null)
  }

  function chipLabel(b: CombineBlock): string {
    if (b.type === 'text') return b.value
    if (!b.value) return ''
    if (isFeedFieldRef(b.value)) return feedFieldLabel(b.value)
    if (b.value.startsWith('metafield:')) return metafieldDisplayName(b.value, metafieldLabels)
    return labels[b.value] ?? b.value
  }

  return (
    <div className="space-y-2">
      <div
        className="flex flex-wrap gap-2 items-center"
        style={{
          minHeight: '42px',
          padding: '8px 10px',
          background: '#ffffff',
          border: '1px solid var(--hairline)',
          borderRadius: '6px',
        }}
      >
        {blocks.length === 0 && (
          <span
            style={{
              fontSize: '11px',
              color: 'var(--ink-muted)',
              fontStyle: 'italic',
            }}
          >
            Add fields and text as chips below
          </span>
        )}
        {blocks.map((block, i) => (
          <CombineChip
            key={i}
            block={block}
            label={chipLabel(block)}
            isDragging={draggedIdx === i}
            dropSide={dropZone?.idx === i ? dropZone.side : null}
            onRemove={() => removeBlock(i)}
            onToggleSkipIfPresent={block.type === 'field' && i > 0 ? () => toggleSkipIfPresent(i) : undefined}
            onDragStart={(e) => onDragStart(e, i)}
            onDragOver={(e) => onDragOver(e, i)}
            onDrop={(e) => onDrop(e, i)}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>

      <div className="flex gap-2 items-center">
        <button
          type="button"
          onClick={() => setPicker(picker === 'field' ? 'none' : 'field')}
          className={`${btnSm} bg-[var(--tint)] text-[var(--accent-ink)] hover:bg-[var(--tint)]`}
          aria-expanded={picker === 'field'}
        >
          + Field
        </button>
        <button
          type="button"
          onClick={() => setPicker(picker === 'text' ? 'none' : 'text')}
          className={`${btnSm} bg-[var(--card-2)] text-[var(--muted)] hover:bg-[var(--canvas-2)]`}
          aria-expanded={picker === 'text'}
        >
          + Text
        </button>
        <label
          className="ml-auto inline-flex items-center gap-1.5 cursor-pointer select-none"
          style={{ fontSize: '11px', color: 'var(--ink-secondary)' }}
          title="When a field is empty, the text in front of it is left out too — no stray separators or double spaces"
        >
          <input
            type="checkbox"
            checked={skipEmpty}
            onChange={(e) => onSkipEmptyChange(e.target.checked)}
            style={{ accentColor: 'var(--accent-ink)' }}
          />
          Skip empty fields
        </label>
      </div>
      {blocks.some((b, i) => i > 0 && b.type === 'field') && (
        <p style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>
          Click <span className="ff-mono">≠</span> on a field to leave it out when the text before it already contains
          that value as a whole word (ignoring case).
        </p>
      )}

      {picker === 'field' && (
        <FieldPickerPanel
          allFields={allFields}
          labels={labels}
          onSelect={addField}
          onClose={() => setPicker('none')}
        />
      )}
      {picker === 'text' && (
        <TextInputPanel onSubmit={addText} onClose={() => setPicker('none')} />
      )}
    </div>
  )
}

function CombineChip({
  block,
  label,
  isDragging,
  dropSide,
  onRemove,
  onToggleSkipIfPresent,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  block: CombineBlock
  label: string
  isDragging: boolean
  dropSide: 'left' | 'right' | null
  onRemove: () => void
  // Field chips after the first: toggles `skipIfPresent`.
  onToggleSkipIfPresent?: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const isField = block.type === 'field'
  const empty = !block.value
  return (
    <span
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`inline-flex items-center gap-1.5 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{
        position: 'relative',
        padding: '4px 4px 4px 8px',
        fontSize: '11px',
        background: isField
          ? 'var(--tint)'
          : 'var(--bg-surface)',
        color: isField
          ? 'var(--tint-fg)'
          : 'var(--ink-secondary)',
        borderRadius: '4px',
        opacity: isDragging ? 0.4 : 1,
        transition: 'opacity 0.12s ease',
        userSelect: 'none',
      }}
    >
      {dropSide && <DropIndicator side={dropSide} />}
      <span
        className="ff-mono"
        style={{
          fontSize: '9px',
          fontWeight: 600,
          opacity: 0.6,
          letterSpacing: '0.04em',
        }}
      >
        {isField ? '{}' : 'txt'}
      </span>
      <span style={{ fontWeight: 500, whiteSpace: 'pre' }}>
        {empty ? <em style={{ opacity: 0.6, fontStyle: 'italic' }}>empty</em> : label}
      </span>
      {onToggleSkipIfPresent && (
        <button
          type="button"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSkipIfPresent()
          }}
          aria-pressed={!!block.skipIfPresent}
          aria-label={block.skipIfPresent ? 'Always include this field' : 'Skip this field if it is already in the text'}
          title={
            block.skipIfPresent
              ? 'Skipped when the text before it already contains this value — click to always include'
              : 'Click to skip this field when the text before it already contains its value'
          }
          className="ff-mono"
          style={{
            padding: '0 5px',
            fontSize: '10px',
            lineHeight: '16px',
            borderRadius: '3px',
            border: '1px solid transparent',
            background: block.skipIfPresent ? 'var(--tint)' : 'transparent',
            color: block.skipIfPresent ? 'var(--tint-fg)' : 'var(--muted)',
            cursor: 'pointer',
          }}
        >
          ≠
        </button>
      )}
      <button
        type="button"
        className="ff-chip-close"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label="Remove chip"
      >
        ×
      </button>
    </span>
  )
}

// Thin vertical accent line shown at the left or right edge of a chip while
// dragging another chip over it. Sits in the 8 px gap between chips, so it
// reads as "insertion between these two chips" rather than "drop on this one".
function DropIndicator({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: '-5px',
        width: '2px',
        background: 'var(--accent-ink)',
        borderRadius: '1px',
        pointerEvents: 'none',
      }}
    />
  )
}

function FieldPickerPanel({
  allFields,
  labels,
  onSelect,
  onClose,
}: {
  allFields: string[]
  labels: Record<string, string>
  onSelect: (field: string) => void
  onClose: () => void
}) {
  const metafieldLabels = useContext(MetafieldLabelsContext)
  const [search, setSearch] = useState('')
  const standard = useMemo(
    () => allFields.filter((f) => !f.startsWith('metafield:')),
    [allFields]
  )
  const meta = useMemo(
    () => allFields.filter((f) => f.startsWith('metafield:')),
    [allFields]
  )

  const feedFields = useMappedFeedFields()

  const q = search.toLowerCase()
  const filteredFeed = q ? feedFields.filter((f) => f.toLowerCase().includes(q)) : feedFields
  const filteredStandard = q
    ? standard.filter(
        (f) =>
          f.toLowerCase().includes(q) ||
          (labels[f] ?? '').toLowerCase().includes(q)
      )
    : standard
  const filteredMeta = q
    ? meta.filter(
        (f) =>
          f.toLowerCase().includes(q) ||
          (metafieldLabels.get(f) ?? '').toLowerCase().includes(q)
      )
    : meta

  return (
    <div
      style={{
        background: '#ffffff',
        border: '1px solid var(--hairline)',
        borderRadius: '6px',
        maxHeight: '280px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div className="p-2" style={{ borderBottom: '1px solid var(--hairline)' }}>
        <input
          type="search"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search fields…"
          className={inp}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        />
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {filteredFeed.length > 0 && (
          <>
            <div
              className="ff-label"
              style={{ padding: '6px 10px', background: 'var(--bg-surface)' }}
            >
              Feed fields (mapped)
            </div>
            {filteredFeed.map((f) => (
              <PickerOption
                key={f}
                onClick={() => onSelect(f)}
                primary={feedFieldLabel(f)}
                secondary="value from that field's mapping"
              />
            ))}
          </>
        )}
        {filteredStandard.length > 0 && (
          <>
            <div
              className="ff-label"
              style={{ padding: '6px 10px', background: 'var(--bg-surface)' }}
            >
              Shopify fields
            </div>
            {filteredStandard.map((f) => (
              <PickerOption
                key={f}
                onClick={() => onSelect(f)}
                primary={labels[f] ?? f}
                secondary={labels[f] && labels[f] !== f ? f : undefined}
              />
            ))}
          </>
        )}
        {filteredMeta.length > 0 && (
          <>
            <div
              className="ff-label"
              style={{ padding: '6px 10px', background: 'var(--bg-surface)' }}
            >
              Metafields
            </div>
            {filteredMeta.map((f) => {
              const rawKey = f.replace('metafield:', '')
              const name = metafieldLabels.get(f)
              return (
                <PickerOption
                  key={f}
                  onClick={() => onSelect(f)}
                  primary={name ?? rawKey}
                  secondary={name ? rawKey : undefined}
                  mono={!name}
                />
              )
            })}
          </>
        )}
        {filteredFeed.length === 0 && filteredStandard.length === 0 && filteredMeta.length === 0 && (
          <p
            className="text-center"
            style={{ padding: '12px', fontSize: '11px', color: 'var(--ink-muted)' }}
          >
            No fields match
          </p>
        )}
      </div>
    </div>
  )
}

function PickerOption({
  onClick,
  primary,
  secondary,
  mono,
}: {
  onClick: () => void
  primary: string
  secondary?: string
  mono?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        fontSize: '11px',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        color: mono ? 'var(--accent-ink)' : 'var(--ink)',
      }}
      className={mono ? 'ff-mono' : undefined}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--bg-surface)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span style={{ fontWeight: 500 }}>{primary}</span>
      {secondary && (
        <span
          className="ff-mono"
          style={{
            marginLeft: '8px',
            fontSize: '10px',
            color: 'var(--ink-muted)',
          }}
        >
          {secondary}
        </span>
      )}
    </button>
  )
}

function TextInputPanel({
  onSubmit,
  onClose,
}: {
  onSubmit: (text: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')

  return (
    <div className="flex gap-2 items-center">
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder='e.g. " - " or " | Buy online"'
        className={inp}
        style={{ flex: 1, minWidth: 0 }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit(value)
          } else if (e.key === 'Escape') {
            onClose()
          }
        }}
      />
      <button
        type="button"
        onClick={() => onSubmit(value)}
        disabled={!value}
        className="ff-btn-primary"
      >
        Add
      </button>
      <button type="button" onClick={onClose} className="ff-btn-secondary">
        Cancel
      </button>
    </div>
  )
}

// ── ExtractEditor ("Extract with pattern") ────────────────────────────────

// Mirrors lib/feedGenerator's ExtractCoverage (kept local: that module is
// server-only).
type ExtractCoverageResult = {
  feedMode: 'product' | 'variant'
  total: number
  matched: number
  perPattern: number[]
  topValues: { value: string; count: number }[]
  unmatched: { id: string; title: string; input: string }[]
  // Added by /api/mapping/extract-test: patterns the run skipped (0-based).
  patternErrors?: { index: number; error: string }[]
}

const nf = new Intl.NumberFormat('en-GB')

function ExtractEditor({
  config,
  onChange,
  allFields,
}: {
  config: Config
  onChange: (c: Config) => void
  allFields: string[]
}) {
  const feedMode = useContext(FeedModeContext)
  const { feedId, previewProduct, marketUrl } = useContext(EditorContext)

  const field = String(config.field ?? '')
  const savedPatterns = config.patterns as ExtractPattern[] | undefined
  const patterns: ExtractPattern[] = savedPatterns?.length
    ? savedPatterns
    : [{ pattern: '', template: '$1', ignoreCase: true }]
  const lookup = (config.lookup as LookupEntry[] | undefined) ?? []
  const [showLookup, setShowLookup] = useState(lookup.length > 0)

  const [coverage, setCoverage] = useState<ExtractCoverageResult | null>(null)
  const [coverageKey, setCoverageKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)

  const set = (key: string, val: unknown) => onChange({ ...config, [key]: val })
  const setPatterns = (next: ExtractPattern[]) => set('patterns', next)
  const setLookup = (next: LookupEntry[]) => set('lookup', next)

  function updatePattern(i: number, patch: Partial<ExtractPattern>) {
    const next = [...patterns]
    next[i] = { ...next[i], ...patch }
    setPatterns(next)
  }
  function movePattern(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= patterns.length) return
    const next = [...patterns]
    ;[next[i], next[j]] = [next[j], next[i]]
    setPatterns(next)
  }

  // Which pattern the preview product hits, and the input it was tested on —
  // the editor's immediate feedback while typing.
  const previewInput = previewProduct && field
    ? resolveClientField(field, previewProduct, marketUrl, feedMode)
    : null
  const previewHit = previewProduct
    ? applyExtract(config, (f) => resolveClientField(f, previewProduct, marketUrl, feedMode))
    : null

  // Coverage results describe the config they were run with; once the user
  // edits, they're marked stale instead of silently showing old numbers.
  const currentKey = JSON.stringify({ field, patterns, lookup })
  const stale = coverage !== null && coverageKey !== currentKey

  async function runCoverage() {
    if (!field) {
      setTestError('Choose a source field first')
      return
    }
    setTesting(true)
    setTestError(null)
    try {
      const res = await fetch(`/api/mapping/extract-test?feedId=${encodeURIComponent(feedId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, patterns, lookup }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
      setCoverage(data as ExtractCoverageResult)
      setCoverageKey(currentKey)
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const itemNoun = (coverage?.feedMode ?? feedMode) === 'variant' ? 'variants' : 'products'

  return (
    <div className="ex">
      <div className="lk-line">
        <span className="lk-kw">FROM</span>
        <FieldSelect value={field} onChange={(v) => set('field', v)} allFields={allFields} />
      </div>

      <div className="ex-body">
        {previewInput !== null && (
          <p className="ex-input" title={previewInput}>
            <b>Input</b> {previewInput || '—'}
          </p>
        )}
        <p className="ex-help">Patterns are tried top to bottom. The first that matches is used; if none matches, the field is left empty.</p>

        {patterns.map((p, i) => {
          const err = patternError(p.pattern, !!p.ignoreCase)
          const isHit = previewHit?.patternIndex === i
          const count = coverage && !stale ? coverage.perPattern[i] : undefined
          return (
            <div key={i} className="ex-item">
              <div className="ex-pat">
                <span className="ex-num">{i + 1}</span>
                <input
                  type="text"
                  value={p.pattern}
                  onChange={(e) => updatePattern(i, { pattern: e.target.value })}
                  placeholder="Regex, e.g. -(\d{2})(\d{2})-"
                  spellCheck={false}
                  aria-label={`Pattern ${i + 1}`}
                  aria-invalid={!!err}
                  className="ff-input ex-code"
                />
                <span className="ex-arrow" aria-hidden="true">→</span>
                <input
                  type="text"
                  value={p.template}
                  onChange={(e) => updatePattern(i, { template: e.target.value })}
                  placeholder="$1/$2"
                  spellCheck={false}
                  aria-label={`Output for pattern ${i + 1}`}
                  className="ff-input ex-code"
                />
                <span className="ex-btns">
                  <button
                    type="button"
                    className="ex-ib"
                    onClick={() => updatePattern(i, { ignoreCase: !p.ignoreCase })}
                    aria-pressed={!!p.ignoreCase}
                    title={p.ignoreCase ? 'Ignoring upper/lower case' : 'Case-sensitive'}
                  >
                    Aa
                  </button>
                  <button type="button" className="ex-ib" onClick={() => movePattern(i, -1)} disabled={i === 0} aria-label="Move up">
                    ↑
                  </button>
                  <button
                    type="button"
                    className="ex-ib"
                    onClick={() => movePattern(i, 1)}
                    disabled={i === patterns.length - 1}
                    aria-label="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="ex-ib x"
                    onClick={() => setPatterns(patterns.filter((_, j) => j !== i))}
                    disabled={patterns.length <= 1}
                    aria-label={`Remove pattern ${i + 1}`}
                  >
                    ×
                  </button>
                </span>
              </div>
              {(err || isHit || count !== undefined) && (
                <div className="ex-meta">
                  {err && <span className="ex-err">{err}</span>}
                  {isHit && <span className="st">Matches the example product</span>}
                  {count !== undefined && (
                    <span>
                      {nf.format(count)} {itemNoun}
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div className="ex-tools">
          <button
            type="button"
            className="ff-btn-ghost"
            onClick={() => setPatterns([...patterns, { pattern: '', template: '$1', ignoreCase: true }])}
          >
            + Pattern
          </button>
          {!showLookup && (
            <button type="button" className="ff-btn-ghost" onClick={() => setShowLookup(true)}>
              + Lookup table
            </button>
          )}
        </div>

        {showLookup && (
          <div className="ex-sec">
            <div className="ex-sec-h">
              <p className="ex-help">
                <b>Lookup</b> Rewrites each captured value before it goes into the output. Ignores upper/lower case.
              </p>
              <button
                type="button"
                className="ff-btn-ghost"
                onClick={() => {
                  onChange(withoutKey(config, 'lookup'))
                  setShowLookup(false)
                }}
              >
                Remove
              </button>
            </div>
            {(lookup.length ? lookup : [{ from: '', to: '' }]).map((row, i, rows) => (
              <div key={i} className="ex-lk">
                <input
                  type="text"
                  className="ff-input"
                  value={row.from}
                  onChange={(e) => {
                    const next = [...rows]
                    next[i] = { ...row, from: e.target.value }
                    setLookup(next)
                  }}
                  placeholder="Captured, e.g. ml"
                  aria-label={`Lookup ${i + 1} from`}
                />
                <span className="ex-arrow" aria-hidden="true">→</span>
                <input
                  type="text"
                  className="ff-input"
                  value={row.to}
                  onChange={(e) => {
                    const next = [...rows]
                    next[i] = { ...row, to: e.target.value }
                    setLookup(next)
                  }}
                  placeholder="Output, e.g. M/L"
                  aria-label={`Lookup ${i + 1} to`}
                />
                <button
                  type="button"
                  className="ex-ib x"
                  onClick={() => setLookup(rows.filter((_, j) => j !== i))}
                  disabled={rows.length <= 1}
                  aria-label={`Remove lookup ${i + 1}`}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="ex-tools">
              <button
                type="button"
                className="ff-btn-ghost"
                onClick={() => setLookup([...(lookup.length ? lookup : [{ from: '', to: '' }]), { from: '', to: '' }])}
              >
                + Row
              </button>
            </div>
          </div>
        )}

        {/* Coverage over the whole feed */}
        <div className="ex-sec">
          <div className="ex-cov">
            <button type="button" className="ff-btn-secondary" onClick={runCoverage} disabled={testing || !feedId}>
              {testing ? 'Testing…' : coverage ? 'Test again' : `Test on all ${itemNoun}`}
            </button>
            {coverage && (
              <span className={stale ? 'ex-stale' : undefined}>
                <b>{nf.format(coverage.matched)}</b> of {nf.format(coverage.total)} {itemNoun} matched
                {coverage.total > 0 && ` (${((coverage.matched / coverage.total) * 100).toFixed(1)} %)`}
                {stale && ' · edited since, test again'}
              </span>
            )}
            {testError && <span className="ex-err">{testError}</span>}
          </div>

          {coverage && !stale && (coverage.patternErrors?.length ?? 0) > 0 && (
            <p className="ex-err">
              Skipped in this test:{' '}
              {coverage.patternErrors!.map((e) => `pattern ${e.index + 1} (${e.error})`).join(' · ')}
            </p>
          )}

          {coverage && !stale && coverage.topValues.length > 0 && (
            <div className="ex-vals">
              {coverage.topValues.map((v) => (
                <span key={v.value} className="ex-val" title={`${v.count} ${itemNoun}`}>
                  {v.value || '(empty)'}
                  <small>{nf.format(v.count)}</small>
                </span>
              ))}
            </div>
          )}

          {coverage && !stale && coverage.unmatched.length > 0 && (
            <details className="ex-miss">
              <summary>
                {nf.format(coverage.total - coverage.matched)} without a match. Show {coverage.unmatched.length}
              </summary>
              <div className="ex-miss-list">
                {coverage.unmatched.map((u) => (
                  <div key={u.id}>
                    <p>{u.title || u.id}</p>
                    <p title={u.input}>{u.input || '(source field is empty)'}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

// ── ConfigEditor ───────────────────────────────────────────────────────────

function ConfigEditor({
  type,
  config,
  onChange,
  allFields,
}: {
  type: MappingType
  config: Config
  onChange: (c: Config) => void
  allFields: string[]
}) {
  const set = (key: string, val: unknown) => onChange({ ...config, [key]: val })

  switch (type) {
    case 'FIELD':
      return (
        <FieldSelect
          value={String(config.field ?? '')}
          onChange={(v) => onChange({ ...config, field: v })}
          allFields={allFields}
        />
      )

    case 'STATIC':
      return (
        <input
          type="text"
          value={String(config.value ?? '')}
          onChange={(e) => onChange({ ...config, value: e.target.value })}
          placeholder="Enter a fixed value…"
          className={inp}
        />
      )

    case 'COMBINE': {
      const blocks = (config.blocks as CombineBlock[]) ?? []
      return (
        <CombineChipsEditor
          blocks={blocks}
          allFields={allFields}
          onChange={(next) => onChange({ ...config, blocks: next })}
          skipEmpty={config.skipEmpty === true}
          onSkipEmptyChange={(v) => onChange(v ? { ...config, skipEmpty: true } : withoutKey(config, 'skipEmpty'))}
        />
      )
    }

    case 'PREFIX_SUFFIX':
      return (
        <div className="grid grid-cols-3 gap-2">
          <input
            type="text"
            value={String(config.prefix ?? '')}
            onChange={(e) => set('prefix', e.target.value)}
            placeholder="Before"
            className={inp}
          />
          <FieldSelect
            value={String(config.field ?? '')}
            onChange={(v) => set('field', v)}
            allFields={allFields}
          />
          <input
            type="text"
            value={String(config.suffix ?? '')}
            onChange={(e) => set('suffix', e.target.value)}
            placeholder="After"
            className={inp}
          />
        </div>
      )

    case 'FIND_REPLACE': {
      const pairs = (config.pairs as { find: string; replace: string }[]) ?? [
        { find: '', replace: '' },
      ]
      return (
        <div className="space-y-2">
          <FieldSelect
            value={String(config.field ?? '')}
            onChange={(v) => set('field', v)}
            allFields={allFields}
          />
          {pairs.map((pair, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="text"
                value={pair.find}
                onChange={(e) => {
                  const next = [...pairs]
                  next[i] = { ...pair, find: e.target.value }
                  set('pairs', next)
                }}
                placeholder="Find…"
                className={inpSm}
              />
              <span className="text-[var(--muted)] opacity-70 text-sm shrink-0">→</span>
              <input
                type="text"
                value={pair.replace}
                onChange={(e) => {
                  const next = [...pairs]
                  next[i] = { ...pair, replace: e.target.value }
                  set('pairs', next)
                }}
                placeholder="Replace with…"
                className={inpSm}
              />
              {pairs.length > 1 && (
                <button
                  type="button"
                  onClick={() => set('pairs', pairs.filter((_, j) => j !== i))}
                  className={`${btnSm} bg-[var(--card-2)] text-[var(--muted)] hover:bg-[var(--canvas-2)] shrink-0`}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => set('pairs', [...pairs, { find: '', replace: '' }])}
            className={`${btnSm} bg-[var(--tint)] text-[var(--accent-ink)] hover:bg-[var(--tint)]`}
          >
            + Add pair
          </button>
        </div>
      )
    }

    case 'TRUNCATE':
      return (
        <div className="flex gap-2 items-center">
          <FieldSelect
            value={String(config.field ?? '')}
            onChange={(v) => set('field', v)}
            allFields={allFields}
          />
          <input
            type="number"
            value={Number(config.maxChars ?? 500)}
            onChange={(e) => set('maxChars', Number(e.target.value))}
            min={1}
            className="w-24 px-3 py-2 rounded-lg border border-[var(--line)] text-sm text-center focus:outline-none focus:ring-2 focus:ring-[rgba(39,67,214,0.15)] shrink-0"
          />
          <span className="text-sm text-[var(--muted)] shrink-0">characters</span>
        </div>
      )

    case 'STRIP_HTML':
      return (
        <FieldSelect
          value={String(config.field ?? '')}
          onChange={(v) => onChange({ ...config, field: v })}
          allFields={allFields}
        />
      )

    case 'LOOKUP':
      return <LookupEditor config={config as LookupConfig} onChange={(c) => onChange({ ...config, ...c })} allFields={allFields} />
    case 'EXTRACT':
      return <ExtractEditor config={config} onChange={onChange} allFields={allFields} />

    case 'AI':
      return (
        <textarea
          value={String(config.prompt ?? '')}
          onChange={(e) => onChange({ ...config, prompt: e.target.value })}
          rows={2}
          placeholder="Describe what Claude should generate from the product data…"
          className="w-full px-3 py-2 rounded-lg border border-[var(--line)] text-sm focus:outline-none focus:ring-2 focus:ring-[rgba(39,67,214,0.15)] focus:border-[var(--accent-ink)] resize-none"
        />
      )

    default:
      return null
  }
}

// ── LookupEditor ───────────────────────────────────────────────────────────

// Lookup table: source field + "value → feed value" rows + what to do when
// nothing matches. Rows can be pasted from a spreadsheet (two columns). The
// logic lives in lib/mappingLookup so the preview and the generated feed agree.
function LookupEditor({
  config,
  onChange,
  allFields,
}: {
  config: LookupConfig
  onChange: (c: LookupConfig) => void
  allFields: string[]
}) {
  const rows: LookupRow[] = config.rows?.length ? config.rows : [{ from: '', to: '' }]
  const [paste, setPaste] = useState<string | null>(null)
  const setRows = (next: LookupRow[]) => onChange({ ...config, rows: next })
  const pasted = paste ? parseLookupPaste(paste) : []

  return (
    <div className="lk">
      <div className="lk-line">
        <span className="lk-kw">LOOK UP</span>
        <FieldSelect value={String(config.field ?? '')} onChange={(v) => onChange({ ...config, field: v })} allFields={allFields} />
      </div>

      <div className="lk-table" role="table" aria-label="Lookup table">
        <div className="lk-head" role="row">
          <span role="columnheader">If the value {config.match === 'contains' ? 'contains' : 'is'}</span>
          <span role="columnheader">then write</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div className="lk-row" role="row" key={i}>
            <input
              className="ff-input"
              value={row.from}
              placeholder="e.g. red"
              aria-label={`Row ${i + 1}: value in the shop`}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, from: e.target.value } : r)))}
            />
            <input
              className="ff-input"
              value={row.to}
              placeholder="e.g. Red"
              aria-label={`Row ${i + 1}: value in the feed`}
              onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, to: e.target.value } : r)))}
            />
            <button
              type="button"
              className="lk-x"
              aria-label={`Remove row ${i + 1}`}
              onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ from: '', to: '' }])}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="lk-tools">
        <button type="button" className="ff-btn-ghost" onClick={() => setRows([...rows, { from: '', to: '' }])}>
          + Row
        </button>
        <button type="button" className="ff-btn-ghost" onClick={() => setPaste(paste === null ? '' : null)}>
          {paste === null ? 'Paste from spreadsheet' : 'Close paste'}
        </button>
        <span className="lk-count">
          {rows.filter((r) => r.from.trim()).length} rows · first match wins
        </span>
      </div>

      {paste !== null && (
        <div className="lk-paste">
          <textarea
            className="ff-input"
            rows={4}
            value={paste}
            placeholder="Copy two columns from Excel or Google Sheets and paste them here."
            onChange={(e) => setPaste(e.target.value)}
          />
          <div className="lk-tools">
            <button
              type="button"
              className="ff-btn-secondary"
              disabled={pasted.length === 0}
              onClick={() => {
                const kept = rows.filter((r) => r.from.trim() || r.to.trim())
                setRows([...kept, ...pasted])
                setPaste(null)
              }}
            >
              Add {pasted.length} {pasted.length === 1 ? 'row' : 'rows'}
            </button>
          </div>
        </div>
      )}

      <div className="lk-opts">
        <label>
          Match
          <select
            className="ff-select"
            value={config.match ?? 'exact'}
            onChange={(e) => onChange({ ...config, match: e.target.value as LookupConfig['match'] })}
          >
            <option value="exact">Whole value equals</option>
            <option value="contains">Value contains</option>
          </select>
        </label>
        <label className="lk-check">
          <input
            type="checkbox"
            checked={config.caseSensitive ?? false}
            onChange={(e) => onChange({ ...config, caseSensitive: e.target.checked })}
          />
          Match case
        </label>
        <label>
          No match
          <select
            className="ff-select"
            value={config.fallback ?? 'source'}
            onChange={(e) => onChange({ ...config, fallback: e.target.value as LookupConfig['fallback'] })}
          >
            <option value="source">Keep the value from the shop</option>
            <option value="empty">Leave the field empty</option>
            <option value="static">Write a fixed value</option>
          </select>
        </label>
        {config.fallback === 'static' && (
          <input
            className="ff-input lk-fallback"
            value={config.fallbackValue ?? ''}
            placeholder="Fixed value"
            aria-label="Fixed value when nothing matches"
            onChange={(e) => onChange({ ...config, fallbackValue: e.target.value })}
          />
        )}
      </div>
    </div>
  )
}

// ── ConditionModeToggle ────────────────────────────────────────────────────

// Inline pill-toggle inside the value column of an OnlyIf condition row.
// "Værdi" stores the bare operator (literal compare); "Felt" appends "_field"
// so the resolver treats the RHS as a product-field path.
function ConditionModeToggle({
  mode,
  onChange,
}: {
  mode: 'value' | 'field'
  onChange: (m: 'value' | 'field') => void
}) {
  return (
    <div
      className="inline-flex shrink-0 self-stretch overflow-hidden"
      style={{
        border: '1px solid var(--hairline)',
        borderRadius: '4px',
      }}
      role="group"
      aria-label="Compare with a value or a field"
    >
      {(['value', 'field'] as const).map((m, idx) => {
        const active = mode === m
        return (
          <button
            key={m}
            type="button"
            onClick={() => mode !== m && onChange(m)}
            style={{
              padding: '0 10px',
              fontSize: '11px',
              fontWeight: 500,
              borderLeft: idx > 0 ? '1px solid var(--hairline)' : 'none',
              background: active ? 'var(--accent-ink)' : '#ffffff',
              color: active ? '#ffffff' : 'var(--ink-secondary)',
              cursor: active ? 'default' : 'pointer',
              transition: 'background 0.12s ease, color 0.12s ease',
            }}
          >
            {m === 'value' ? 'Value' : 'Field'}
          </button>
        )
      })}
    </div>
  )
}

// ── Condition rows ─────────────────────────────────────────────────────────

// The condition list of ONE branch. Rendered by the primary ONLY IF and by
// every ELSE IF rule, so a condition row looks and behaves identically wherever
// it appears.
function ConditionRows({
  label,
  conditions,
  onChange,
  allFields,
}: {
  label: string
  conditions: Condition[]
  onChange: (next: Condition[]) => void
  allFields: string[]
}) {
  return (
    <>
      {conditions.map((cond, i) => {
        const noVal = NO_VALUE_OPERATORS.includes(cond.operator)
        const base = baseOperator(cond.operator)
        const mode: 'value' | 'field' = isFieldOperator(cond.operator) ? 'field' : 'value'
        const showModeToggle = !noVal && MODE_AWARE_OPERATORS.has(base)

        const patch = (next: Partial<Condition>) => {
          const list = [...conditions]
          list[i] = { ...list[i], ...next }
          onChange(list)
        }

        return (
          <div key={i} className="flex gap-2 items-start">
            {i === 0 ? (
              <span className={condLbl}>{label}</span>
            ) : (
              <select
                value={cond.logic ?? 'AND'}
                onChange={(e) => patch({ logic: e.target.value as 'AND' | 'OR' })}
                className={miniSel}
                style={{ flex: '0 0 64px' }}
              >
                <option value="AND">AND</option>
                <option value="OR">OR</option>
              </select>
            )}
            <div style={{ flex: '0 0 160px' }}>
              <FieldSelect
                value={cond.field}
                onChange={(v) => patch({ field: v })}
                allFields={allFields}
              />
            </div>
            <select
              value={base}
              onChange={(e) => patch({ operator: withOperatorMode(e.target.value, mode), value: '' })}
              className={miniSel}
              style={{ flex: '0 0 140px' }}
            >
              {OPERATORS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {!noVal && (
              <div className="flex-1 min-w-0 flex gap-1.5 items-stretch">
                {showModeToggle && (
                  <ConditionModeToggle
                    mode={mode}
                    onChange={(nextMode) =>
                      patch({ operator: withOperatorMode(base, nextMode), value: '' })
                    }
                  />
                )}
                <div className="flex-1 min-w-0">
                  {mode === 'field' ? (
                    <FieldSelect
                      value={cond.value}
                      onChange={(v) => patch({ value: v })}
                      allFields={allFields}
                    />
                  ) : (
                    <input
                      type="text"
                      value={cond.value}
                      onChange={(e) => patch({ value: e.target.value })}
                      placeholder="Value…"
                      className={inp}
                    />
                  )}
                </div>
                {CASE_AWARE_OPERATORS.has(base) && (
                  <button
                    type="button"
                    onClick={() => patch({ caseSensitive: cond.caseSensitive === false })}
                    aria-pressed={cond.caseSensitive === false}
                    title={
                      cond.caseSensitive === false
                        ? 'Ignoring upper/lower case — click to match case'
                        : 'Case-sensitive — click to ignore upper/lower case'
                    }
                    className={`${btnSm} shrink-0`}
                    style={
                      cond.caseSensitive === false
                        ? { color: 'var(--tint-fg)', borderColor: 'transparent', background: 'var(--tint)' }
                        : undefined
                    }
                  >
                    Aa
                  </button>
                )}
              </div>
            )}
            {conditions.length > 1 && (
              <button
                type="button"
                onClick={() => onChange(conditions.filter((_, j) => j !== i))}
                className={`${btnSm} bg-[var(--card-2)] text-[var(--muted)] hover:bg-[var(--canvas-2)] mt-0.5`}
                style={{ flex: 'none' }}
              >
                ×
              </button>
            )}
          </div>
        )
      })}

      <div className="flex gap-2 pl-16">
        <button
          type="button"
          onClick={() => onChange([...conditions, newCondition('AND')])}
          className={`${btnSm} bg-[var(--card-2)] text-[var(--muted)] hover:bg-[var(--canvas-2)]`}
        >
          + AND
        </button>
        <button
          type="button"
          onClick={() => onChange([...conditions, newCondition('OR')])}
          className={`${btnSm} bg-[var(--card-2)] text-[var(--muted)] hover:bg-[var(--canvas-2)]`}
        >
          + OR
        </button>
      </div>
    </>
  )
}

// ── ValueSpecEditor ────────────────────────────────────────────────────────

// The value a branch produces: nothing, a literal, a field, or a combination.
// Used by every ELSE IF rule and by the final ELSE.
function ValueSpecEditor({
  label,
  value,
  onChange,
  allFields,
}: {
  label: string
  value: ValueSpec
  onChange: (next: ValueSpec) => void
  allFields: string[]
}) {
  return (
    <div className="flex gap-2 items-start">
      <span className={condLbl}>{label}</span>
      <select
        value={value.type}
        onChange={(e) => {
          const next = e.target.value as ValueSpec['type']
          onChange(next === 'combine' ? { type: 'combine', blocks: [], skipEmpty: true } : { type: next, value: '' })
        }}
        className={miniSel}
        style={{ flex: '0 0 120px' }}
      >
        <option value="empty">Empty</option>
        <option value="static">Static</option>
        <option value="field">Field</option>
        <option value="combine">Combine</option>
      </select>
      <div className="flex-1 min-w-0">
        {value.type === 'static' && (
          <input
            type="text"
            value={value.value}
            onChange={(e) => onChange({ type: 'static', value: e.target.value })}
            placeholder='e.g. "out_of_stock"'
            className={inp}
          />
        )}
        {value.type === 'field' && (
          <FieldSelect
            value={value.value}
            onChange={(v) => onChange({ type: 'field', value: v })}
            allFields={allFields}
          />
        )}
        {value.type === 'empty' && (
          <span className="text-sm text-[var(--muted)] opacity-70 italic pt-1.5">The field stays empty</span>
        )}
        {value.type === 'combine' && (
          <CombineChipsEditor
            blocks={value.blocks ?? []}
            allFields={allFields}
            onChange={(next) => onChange({ ...value, blocks: next })}
            skipEmpty={!!value.skipEmpty}
            onSkipEmptyChange={(v) => onChange({ type: 'combine', blocks: value.blocks ?? [], ...(v ? { skipEmpty: true } : {}) })}
          />
        )}
      </div>
    </div>
  )
}

// ── OnlyIfEditor ───────────────────────────────────────────────────────────

// The full rule stack for one field.
//
//   ONLY IF  <conditions>  → the mapping configured above this panel
//   ELSE IF  <conditions>  → THEN <value>     (any number, in priority order)
//   ELSE                   → <value>
//
// Top-down, first match wins — so moving a rule up makes it win over the ones
// below it. The order shown here is literally the evaluation order; the
// matching logic lives in lib/mappingRules.
function OnlyIfEditor({
  value,
  onChange,
  onRemove,
  allFields,
}: {
  value: OnlyIf
  onChange: (v: OnlyIf) => void
  onRemove: () => void
  allFields: string[]
}) {
  const { conditions, else: elseBranch } = value
  const rules = value.rules ?? []

  const setRules = (next: Rule[]) => onChange({ ...value, rules: next })
  const patchRule = (i: number, next: Partial<Rule>) => {
    const list = [...rules]
    list[i] = { ...list[i], ...next }
    setRules(list)
  }
  const moveRule = (i: number, delta: number) => {
    const target = i + delta
    if (target < 0 || target >= rules.length) return
    const list = [...rules]
    const [moved] = list.splice(i, 1)
    list.splice(target, 0, moved)
    setRules(list)
  }

  return (
    <div className="space-y-2 py-2">

      <ConditionRows
        label="ONLY IF"
        conditions={conditions}
        onChange={(next) => onChange({ ...value, conditions: next })}
        allFields={allFields}
      />

      {rules.map((rule, i) => (
        <div
          key={i}
          className="space-y-2 pt-2.5 mt-2.5"
          style={{ borderTop: '1px dashed var(--hairline)' }}
        >
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0 space-y-2">
              <ConditionRows
                label="ELSE IF"
                conditions={rule.conditions}
                onChange={(next) => patchRule(i, { conditions: next })}
                allFields={allFields}
              />
            </div>
            <div className="flex items-center gap-1 shrink-0 pt-1.5">
              <button
                type="button"
                onClick={() => moveRule(i, -1)}
                disabled={i === 0}
                title="Higher priority"
                aria-label="Move rule up"
                className={`${btnSm} ${i === 0 ? 'opacity-30 cursor-default' : 'hover:bg-[var(--bg-surface)]'}`}
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => moveRule(i, 1)}
                disabled={i === rules.length - 1}
                title="Lower priority"
                aria-label="Move rule down"
                className={`${btnSm} ${i === rules.length - 1 ? 'opacity-30 cursor-default' : 'hover:bg-[var(--bg-surface)]'}`}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => setRules(rules.filter((_, j) => j !== i))}
                title="Remove rule"
                aria-label="Remove rule"
                className={`${btnSm} hover:bg-[var(--bad-bg)] hover:text-[var(--bad)]`}
              >
                ×
              </button>
            </div>
          </div>
          <ValueSpecEditor
            label="THEN"
            value={rule.value}
            onChange={(next) => patchRule(i, { value: next })}
            allFields={allFields}
          />
        </div>
      ))}

      <div className="flex pl-16 pt-0.5">
        <button
          type="button"
          onClick={() =>
            setRules([
              ...rules,
              {
                conditions: [newCondition(null)],
                value: { type: 'static', value: '' },
              },
            ])
          }
          className={`${btnSm} bg-[var(--tint)] text-[var(--accent-ink)] hover:bg-[var(--tint)]`}
        >
          + Else if
        </button>
      </div>

      <div className="border-t border-[var(--tint)] pt-2">
        <ValueSpecEditor
          label="ELSE"
          value={elseBranch}
          onChange={(next) => onChange({ ...value, else: next })}
          allFields={allFields}
        />
      </div>

      {rules.length > 0 && (
        <p className="pl-16" style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
          Rules are read from the top. The first rule that matches wins.
        </p>
      )}

      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-[var(--muted)] opacity-70 hover:text-[var(--bad)] transition-colors"
        >
          Remove condition
        </button>
      </div>

    </div>
  )
}

// ── PreviewValueText ───────────────────────────────────────────────────────

// Renders one resolved value the way it will actually be written to the feed.
//
// Two things matter here and both used to be wrong for `description`:
//
//  * Line breaks are REAL content. The value arrives with the paragraph breaks
//    stripHtml preserved, so it is rendered `pre-wrap` rather than collapsed
//    into one running sentence.
//  * The whole value must be reachable. A description is an order of magnitude
//    longer than any other field, so a fixed two-line clamp hid most of it with
//    no way to see the rest. Long values collapse to a few lines and expand in
//    place; short ones render untouched with no affordance at all.

// Roughly "longer than the collapsed box can show". Only a heuristic — it
// decides whether to OFFER the toggle, never whether text is reachable.
function isLongValue(value: string): boolean {
  return value.length > 160 || value.split('\n').length > 3
}

// A value that is still a raw Shopify global ID.
//
// This is what a metaobject reference looks like when it was never translated
// to its display value — the feed would carry "gid://shopify/Metaobject/12345"
// where "Piemonte" belongs. It is never a legitimate feed value, so the preview
// names it instead of rendering it in the same purple as a real value and
// letting it reach Google unnoticed.
const SHOPIFY_GID_RE = /gid:\/\/shopify\/[A-Za-z]+\/\d+/

function UnresolvedReference({ value }: { value: string }) {
  return (
    <span
      title={
        'Unresolved Shopify reference. The metaobject was not translated to its value ' +
        'during sync. Usually the access token is missing the read_metaobjects scope. ' +
        'Check the shop connection and sync the feed again.'
      }
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}
    >
      <span
        className="ff-badge"
        style={{
          background: 'rgba(232, 163, 23, 0.14)',
          color: '#8a6100',
          border: '1px solid rgba(232, 163, 23, 0.35)',
          whiteSpace: 'nowrap',
        }}
      >
        Unresolved reference
      </span>
      <span
        className="ff-mono"
        style={{ fontSize: '10px', color: 'var(--ink-muted)', overflowWrap: 'anywhere' }}
      >
        {value}
      </span>
    </span>
  )
}

function PreviewValueText({
  value,
  align = 'left',
}: {
  value: string
  // The sidebar's value column is right-aligned for short scalar values; long
  // multi-line text always reads left-aligned regardless.
  align?: 'left' | 'right'
}) {
  const [expanded, setExpanded] = useState(false)
  const long = isLongValue(value)
  const leftAlign = long || align === 'left'

  if (SHOPIFY_GID_RE.test(value)) {
    return (
      <div style={{ textAlign: 'left' }}>
        <UnresolvedReference value={value} />
      </div>
    )
  }

  return (
    <div style={{ textAlign: leftAlign ? 'left' : 'right' }}>
      <span
        style={{
          display: 'block',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          // 1.55 line-height × 4 lines. Collapsed height is a soft preview, not
          // a limit — the toggle below always reveals the rest.
          maxHeight: long && !expanded ? '6.2em' : undefined,
          overflow: long && !expanded ? 'hidden' : undefined,
          lineHeight: 1.55,
        }}
      >
        {value}
      </span>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            marginTop: '2px',
            fontSize: '10px',
            fontWeight: 500,
            color: 'var(--accent-ink)',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Show less' : `Show all (${value.length} characters)`}
        </button>
      )}
    </div>
  )
}

// ── TransformsEditor (the filter layer) ────────────────────────────────────

// Filters stack ON TOP of whatever the mapping above them produced, in order.
// That is the whole point: "Strip HTML" is a main function, but you also want
// to run a Find & Replace over the plain text it produced — which the main
// function alone can't express, because a field has exactly one of those.
//
// Runs last, on whichever rule branch won, so a filter is written once and
// applies to every branch. See lib/mappingTransforms.

const TRANSFORM_ORDER: TransformType[] = [
  'STRIP_HTML',
  'FIND_REPLACE',
  'TRUNCATE',
  'PREFIX_SUFFIX',
]

function newTransform(type: TransformType): Transform {
  switch (type) {
    case 'FIND_REPLACE': return { type, pairs: [{ find: '', replace: '' }] }
    case 'TRUNCATE': return { type, maxChars: 500 }
    case 'PREFIX_SUFFIX': return { type, prefix: '', suffix: '' }
    default: return { type }
  }
}

function TransformBody({
  transform,
  onChange,
}: {
  transform: Transform
  onChange: (next: Transform) => void
}) {
  switch (transform.type) {
    case 'STRIP_HTML':
      return (
        <span className="text-sm text-[var(--muted)] opacity-70 italic pt-1.5">
          Removes HTML tags and keeps paragraph breaks
        </span>
      )

    case 'FIND_REPLACE': {
      const pairs = transform.pairs?.length ? transform.pairs : [{ find: '', replace: '' }]
      const setPairs = (next: { find: string; replace: string }[]) =>
        onChange({ ...transform, pairs: next })
      return (
        <div className="space-y-2">
          {pairs.map((pair, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="text"
                value={pair.find}
                onChange={(e) => {
                  const next = [...pairs]
                  next[i] = { ...pair, find: e.target.value }
                  setPairs(next)
                }}
                placeholder="Find…"
                className={inpSm}
              />
              <span className="text-[var(--muted)] opacity-70 text-sm shrink-0">→</span>
              <input
                type="text"
                value={pair.replace}
                onChange={(e) => {
                  const next = [...pairs]
                  next[i] = { ...pair, replace: e.target.value }
                  setPairs(next)
                }}
                placeholder="Replace with…"
                className={inpSm}
              />
              {pairs.length > 1 && (
                <button
                  type="button"
                  onClick={() => setPairs(pairs.filter((_, j) => j !== i))}
                  className={`${btnSm} bg-[var(--card-2)] text-[var(--muted)] hover:bg-[var(--canvas-2)] shrink-0`}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setPairs([...pairs, { find: '', replace: '' }])}
            className={`${btnSm} bg-[var(--tint)] text-[var(--accent-ink)] hover:bg-[var(--tint)]`}
          >
            + Add pair
          </button>
        </div>
      )
    }

    case 'TRUNCATE':
      return (
        <div className="flex gap-2 items-center">
          <input
            type="number"
            value={Number(transform.maxChars ?? 500)}
            onChange={(e) => onChange({ ...transform, maxChars: Number(e.target.value) })}
            min={1}
            className="w-24 px-3 py-2 rounded-lg border border-[var(--line)] text-sm text-center focus:outline-none focus:ring-2 focus:ring-[rgba(39,67,214,0.15)] shrink-0"
          />
          <span className="text-sm text-[var(--muted)] shrink-0">characters</span>
        </div>
      )

    case 'PREFIX_SUFFIX':
      return (
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={transform.prefix ?? ''}
            onChange={(e) => onChange({ ...transform, prefix: e.target.value })}
            placeholder="Before"
            className={inp}
          />
          <input
            type="text"
            value={transform.suffix ?? ''}
            onChange={(e) => onChange({ ...transform, suffix: e.target.value })}
            placeholder="After"
            className={inp}
          />
        </div>
      )

    default:
      return null
  }
}

function TransformsEditor({
  transforms,
  onChange,
  onRemove,
}: {
  transforms: Transform[]
  onChange: (next: Transform[]) => void
  onRemove: () => void
}) {
  const [adding, setAdding] = useState(false)

  const patch = (i: number, next: Transform) => {
    const list = [...transforms]
    list[i] = next
    onChange(list)
  }
  const move = (i: number, delta: number) => {
    const target = i + delta
    if (target < 0 || target >= transforms.length) return
    const list = [...transforms]
    const [moved] = list.splice(i, 1)
    list.splice(target, 0, moved)
    onChange(list)
  }

  return (
    <div className="space-y-2 py-2">
      {transforms.length === 0 && (
        <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
          No formatting yet. Add one to run it on the mapped value.
        </p>
      )}

      {transforms.map((t, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className={condLbl}>THEN</span>
          <div
            className="shrink-0 pt-2"
            style={{ width: '128px', fontSize: '12px', color: 'var(--ink)' }}
          >
            {TRANSFORM_LABELS[t.type] ?? t.type}
          </div>
          <div className="flex-1 min-w-0">
            <TransformBody transform={t} onChange={(next) => patch(i, next)} />
          </div>
          <div className="flex items-center gap-1 shrink-0 pt-1.5">
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              title="Run earlier"
              aria-label="Move formatting up"
              className={`${btnSm} ${i === 0 ? 'opacity-30 cursor-default' : 'hover:bg-[var(--bg-surface)]'}`}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === transforms.length - 1}
              title="Run later"
              aria-label="Move formatting down"
              className={`${btnSm} ${i === transforms.length - 1 ? 'opacity-30 cursor-default' : 'hover:bg-[var(--bg-surface)]'}`}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onChange(transforms.filter((_, j) => j !== i))}
              title="Remove formatting"
              aria-label="Remove formatting"
              className={`${btnSm} hover:bg-[var(--bad-bg)] hover:text-[var(--bad)]`}
            >
              ×
            </button>
          </div>
        </div>
      ))}

      <div className="flex gap-2 items-center" style={{ paddingLeft: '72px' }}>
        {adding ? (
          <>
            {TRANSFORM_ORDER.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => {
                  onChange([...transforms, newTransform(type)])
                  setAdding(false)
                }}
                className={`${btnSm} hover:bg-[var(--bg-surface)]`}
              >
                {TRANSFORM_LABELS[type]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="text-xs text-[var(--muted)] opacity-70 hover:text-[var(--muted)] transition-colors"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className={`${btnSm} bg-[var(--tint)] text-[var(--accent-ink)] hover:bg-[var(--tint)]`}
          >
            + Add formatting
          </button>
        )}
      </div>

      {transforms.length > 1 && (
        <p style={{ fontSize: '11px', color: 'var(--ink-muted)', paddingLeft: '72px' }}>
          Runs from the top, each on the result of the one above.
        </p>
      )}

      <div className="flex justify-end pt-1">
        <button
          type="button"
          onClick={onRemove}
          className="text-xs text-[var(--muted)] opacity-70 hover:text-[var(--bad)] transition-colors"
        >
          Remove formatting
        </button>
      </div>
    </div>
  )
}

// ── FieldRow ───────────────────────────────────────────────────────────────

function FieldRow({
  field,
  state,
  allFields,
  onTypeChange,
  onConfigChange,
  previewValue,
  onRemove,
  onPreview,
}: {
  field: string
  state: FieldState
  allFields: string[]
  onTypeChange: (t: MappingType) => void
  onConfigChange: (c: Config) => void
  previewValue: string | null
  // When set, renders a small × button next to the field name. Used by the
  // Custom-felter section to delete a user-defined field.
  onRemove?: () => void
  // When set, renders a hover-only "Preview" button that opens the field
  // preview sidebar for this row.
  onPreview?: () => void
}) {
  // Strip the "custom:" prefix when displaying user-defined fields. The
  // underlying mapping key keeps the prefix so feedGenerator can detect it.
  const displayField = field.startsWith('custom:') ? field.slice('custom:'.length) : field
  const onlyIf = state.config.onlyIf as OnlyIf | undefined
  const [showOnlyIf, setShowOnlyIf] = useState(!!onlyIf?.conditions?.length)
  const hasConditions = onlyIf?.conditions?.some((c) => c.field) ?? false

  const transforms = configTransforms(state.config)
  const [showTransforms, setShowTransforms] = useState(transforms.length > 0)

  function openOnlyIf() {
    if (!onlyIf) {
      onConfigChange({
        ...state.config,
        onlyIf: {
          conditions: [newCondition(null)],
          else: { type: 'empty', value: '' },
        } satisfies OnlyIf,
      })
    }
    setShowOnlyIf(true)
  }

  function removeOnlyIf() {
    onConfigChange(withoutKey(state.config, 'onlyIf'))
    setShowOnlyIf(false)
  }

  function removeTransforms() {
    onConfigChange(withoutKey(state.config, 'transforms'))
    setShowTransforms(false)
  }

  return (
    <CurrentFieldContext.Provider value={field}>
    <div className="mp-row group">
      <div className="flex items-start gap-3">
        <div className="w-52 pt-1 shrink-0">
          <div className="flex items-center justify-between gap-1.5">
            <span className={`mp-name${state.type ? '' : ' off'}`}>
              <span className="mp-ic">
                <Icon name={fieldIcon(displayField)} size={14} />
              </span>
              <span className="mp-n" title={displayField}>
                {displayField}
              </span>
              {!state.type && REQUIRED_SET.has(field) && <span className="pill bad">Missing</span>}
              {state.type === 'AI' && <span className="mp-ai">AI</span>}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {onPreview && (
                <button
                  type="button"
                  onClick={onPreview}
                  title="See the field across products"
                  className="mp-mini"
                >
                  Preview
                </button>
              )}
              {onRemove && (
                <button
                  type="button"
                  onClick={onRemove}
                  aria-label={`Delete the field ${displayField}`}
                  title="Delete custom field"
                  style={{
                    width: '18px',
                    height: '18px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    border: '1px solid var(--hairline)',
                    borderRadius: '4px',
                    background: 'transparent',
                    color: 'var(--ink-muted)',
                    cursor: 'pointer',
                    fontSize: '12px',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="w-40 shrink-0">
          <select
            value={state.type}
            onChange={(e) => onTypeChange(e.target.value as MappingType)}
            className={sel}
          >
            {MAPPING_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        {/* Pattern lists and lookup tables need more room than one dropdown:
            they get their own full-width line under the field. */}
        <div className={`flex-1 min-w-0${WIDE_EDITORS.has(state.type) ? ' mp-wide' : ''}`}>
          {state.type !== '' && (
            <ConfigEditor
              type={state.type}
              config={state.config}
              onChange={onConfigChange}
              allFields={allFields}
            />
          )}
        </div>
        {state.type !== '' && (
          <div className="flex items-start gap-1.5 shrink-0 mt-0.5">
            <button
              type="button"
              // Pure show/hide. Unlike "Only if", this button never deletes:
              // the badge is a count, and losing two configured filters to a
              // mis-click on the thing that reports them would be a trap.
              // Deleting is the explicit "Remove filters" link inside the panel.
              onClick={() => setShowTransforms((v) => !v)}
              title="Format the value further: strip HTML, find and replace, truncate, add before/after"
              className={`mp-chip${transforms.length > 0 ? ' on' : ''}`}
            >
              {transforms.length > 0 ? `Formatting · ${transforms.length}` : '+ Formatting'}
            </button>
            <button
              type="button"
              onClick={showOnlyIf ? removeOnlyIf : openOnlyIf}
              title="Use a different value when a condition is met"
              className={`mp-chip${hasConditions ? ' on' : ''}`}
            >
              {hasConditions ? 'Rules ✓' : '+ Rule'}
            </button>
            {showOnlyIf && (
              <button
                type="button"
                onClick={removeOnlyIf}
                title="Remove all rules"
                aria-label="Remove all rules"
                className="mp-chip mp-chip-x"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>

      {/* Live preview value */}
      {previewValue !== null && state.type !== '' && (
        <div className="flex gap-4 mt-1.5">
          <div className="w-52 shrink-0" />
          <div className="w-40 shrink-0" />
          <div className="flex-1 min-w-0 flex items-start gap-1.5">
            {previewValue === AI_PLACEHOLDER ? (
              <span className="pill ai">Written by AI, can’t be shown here</span>
            ) : previewValue === '' ? (
              <span className="neg mp-prev">Empty</span>
            ) : (
              <>
                <span className="mp-prev-arrow shrink-0">→</span>
                <div className="flex-1 min-w-0 mp-prev">
                  <PreviewValueText value={previewValue} />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showTransforms && state.type !== '' && (
        <div
          className="mp-sub"
        >
          <TransformsEditor
            transforms={transforms}
            onChange={(next) => onConfigChange({ ...state.config, transforms: next })}
            onRemove={removeTransforms}
          />
        </div>
      )}

      {showOnlyIf && state.type !== '' && onlyIf && (
        <div
          className="mp-sub"
        >
          <OnlyIfEditor
            value={onlyIf}
            onChange={(next) => onConfigChange({ ...state.config, onlyIf: next })}
            onRemove={removeOnlyIf}
            allFields={allFields}
          />
        </div>
      )}
    </div>
    </CurrentFieldContext.Provider>
  )
}

// ── Used-field collection ──────────────────────────────────────────────────

// Walks a single field's mapping state and returns every Shopify field it
// references — including nested references inside COMBINE blocks and onlyIf
// conditions/else-branches. Used by the "Shopify felter" panel to badge each
// field as mapped or unmapped.
function collectUsedFields(state: FieldState): string[] {
  const used: string[] = []
  const cfg = state.config

  switch (state.type) {
    case 'FIELD':
    case 'PREFIX_SUFFIX':
    case 'FIND_REPLACE':
    case 'TRUNCATE':
    case 'STRIP_HTML':
    case 'LOOKUP':
    case 'EXTRACT': {
      const f = String(cfg.field ?? '')
      if (f) used.push(f)
      break
    }
    case 'COMBINE': {
      const blocks = (cfg.blocks as { type: 'field' | 'text'; value: string }[]) ?? []
      for (const b of blocks) {
        if (b.type === 'field' && b.value) used.push(b.value)
      }
      break
    }
  }

  // Conditions, ELSE IF rules and the fallback all reference fields too.
  used.push(...collectRuleFields(cfg.onlyIf as OnlyIf | undefined))

  // `feed:` references point at other mappings, not Shopify fields.
  return used.filter((f) => !isFeedFieldRef(f))
}

// ── ShopifyFieldsModal ─────────────────────────────────────────────────────

function MappedBadge({ mapped }: { mapped: boolean }) {
  return (
    <span
      className={`shrink-0 text-xs px-2 py-0.5 rounded font-medium ${
        mapped ? 'bg-[var(--good-bg)] text-[var(--good)]' : 'bg-[var(--card-2)] text-[var(--muted)]'
      }`}
    >
      {mapped ? 'Mapped' : 'Not mapped'}
    </span>
  )
}

function FieldExample({ value }: { value: string }) {
  if (!value) {
    return <span className="text-[var(--muted)] opacity-70 italic">empty</span>
  }
  const trimmed = value.length > 120 ? value.slice(0, 120) + '…' : value
  return <span>{trimmed}</span>
}

function ShopifyFieldsModal({
  standardFields,
  metafields,
  product,
  loading,
  marketUrl,
  usedFields,
  onClose,
}: {
  standardFields: string[]
  metafields: { namespace: string; key: string; name?: string }[]
  product: PreviewProduct | null
  loading: boolean
  marketUrl: string | null
  usedFields: Set<string>
  onClose: () => void
}) {
  const feedMode = useContext(FeedModeContext)
  const labels = useMemo(() => getFieldLabels(feedMode), [feedMode])
  const [search, setSearch] = useState('')

  function exampleFor(field: string): string {
    if (!product) return ''
    return resolveClientField(field, product, marketUrl, feedMode)
  }

  const q = search.toLowerCase()
  const filteredStandard = q ? standardFields.filter((f) => f.toLowerCase().includes(q)) : standardFields
  const filteredMeta = q
    ? metafields.filter(
        (m) =>
          `${m.namespace}.${m.key}`.toLowerCase().includes(q) ||
          (m.name ?? '').toLowerCase().includes(q)
      )
    : metafields

  const totalMapped =
    standardFields.filter((f) => usedFields.has(f)).length +
    metafields.filter((m) => usedFields.has(`metafield:${m.namespace}.${m.key}`)).length
  const totalFields = standardFields.length + metafields.length

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-white rounded-xl shadow-xl border border-[var(--line)] w-full max-w-3xl flex flex-col max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[var(--line)] shrink-0">
          <h2 className="text-base font-semibold text-[var(--ink)]">Shopify fields</h2>
          <p className="text-sm text-[var(--muted)] mt-0.5">
            {totalMapped} of {totalFields} fields are used in a mapping
            {product ? ` — example values from "${product.title}"` : ''}
          </p>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search fields…"
            className="mt-3 w-full px-3 py-2 rounded-lg border border-[var(--line)] text-sm focus:outline-none focus:ring-2 focus:ring-[rgba(39,67,214,0.15)] focus:border-[var(--accent-ink)]"
          />
        </div>

        <div className="overflow-y-auto flex-1">
          {/* Standard fields */}
          <div className="px-6 py-2 bg-[var(--card-2)] border-b border-[var(--line)] sticky top-0 z-10">
            <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
              Standard fields
            </h3>
          </div>
          {loading && !product ? (
            <div className="p-6 text-center text-sm text-[var(--muted)] opacity-70">Loading example values…</div>
          ) : filteredStandard.length === 0 ? (
            <div className="p-6 text-center text-sm text-[var(--muted)] opacity-70">No fields match your search</div>
          ) : (
            filteredStandard.map((f) => (
              <div
                key={f}
                className="flex items-start gap-3 px-6 py-2.5 border-b border-[var(--line)] last:border-b-0"
              >
                <div className="w-52 shrink-0 pt-0.5">
                  <code className="text-xs font-mono text-[var(--ink)]">{labels[f] ?? f}</code>
                </div>
                <div className="flex-1 min-w-0 text-xs text-[var(--muted)] break-all pt-0.5">
                  <FieldExample value={exampleFor(f)} />
                </div>
                <MappedBadge mapped={usedFields.has(f)} />
              </div>
            ))
          )}

          {/* Metafields */}
          {metafields.length > 0 && (
            <>
              <div className="px-6 py-2 bg-[var(--card-2)] border-b border-[var(--line)] sticky top-0 z-10">
                <h3 className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">
                  Metafields ({metafields.length})
                </h3>
              </div>
              {filteredMeta.length === 0 ? (
                <div className="p-6 text-center text-sm text-[var(--muted)] opacity-70">No metafields match your search</div>
              ) : (
                filteredMeta.map((m) => {
                  const fullKey = `metafield:${m.namespace}.${m.key}`
                  const rawKey = `${m.namespace}.${m.key}`
                  return (
                    <div
                      key={fullKey}
                      className="flex items-start gap-3 px-6 py-2.5 border-b border-[var(--line)] last:border-b-0"
                    >
                      <div className="w-52 shrink-0 pt-0.5">
                        {m.name ? (
                          <>
                            <span className="text-xs font-medium text-[var(--ink)]">{m.name}</span>
                            <code className="block text-[10px] font-mono text-[var(--muted)] opacity-70">{rawKey}</code>
                          </>
                        ) : (
                          <code className="text-xs font-mono text-[var(--ink)]">{rawKey}</code>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 text-xs text-[var(--muted)] break-all pt-0.5">
                        <FieldExample value={exampleFor(fullKey)} />
                      </div>
                      <MappedBadge mapped={usedFields.has(fullKey)} />
                    </div>
                  )
                })
              )}
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-[var(--line)] flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-[var(--line)] text-sm text-[var(--muted)] hover:bg-[var(--canvas-2)] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── ProductPickerModal ─────────────────────────────────────────────────────

// Self-fetching picker: pulls products from /api/products with server-side
// search + 20-per-page pagination. Replaces the old "load everything client
// side and filter locally" approach so it scales to feeds with thousands of
// products.
const PICKER_PAGE_SIZE = 20

function ProductPickerModal({
  feedId,
  onSelect,
  onClose,
}: {
  feedId: string
  onSelect: (p: PreviewProduct) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [products, setProducts] = useState<PreviewProduct[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  // Key of the last request that settled; loading = current key not settled yet.
  const [settledKey, setSettledKey] = useState<string | null>(null)

  // 300 ms debounce on the typed query → committed search.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // New search resets paging so the user lands on results from page 1
  // (adjust state during render when the committed search changes).
  const [prevDebouncedSearch, setPrevDebouncedSearch] = useState(debouncedSearch)
  if (prevDebouncedSearch !== debouncedSearch) {
    setPrevDebouncedSearch(debouncedSearch)
    setPage(1)
  }

  const requestKey = JSON.stringify([feedId, debouncedSearch, page])
  const loading = settledKey !== requestKey

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({
      feedId,
      page: String(page),
      pageSize: String(PICKER_PAGE_SIZE),
    })
    if (debouncedSearch) params.set('search', debouncedSearch)

    fetch(`/api/products?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as {
          products?: PreviewProduct[]
          total?: number
          totalPages?: number
        }
      })
      .then((data) => {
        if (cancelled) return
        setProducts(data.products ?? [])
        setTotal(data.total ?? 0)
        setTotalPages(Math.max(1, data.totalPages ?? 1))
      })
      .catch(() => {
        if (!cancelled) {
          setProducts([])
          setTotal(0)
          setTotalPages(1)
        }
      })
      .finally(() => {
        if (!cancelled) setSettledKey(requestKey)
      })

    return () => {
      cancelled = true
    }
  }, [feedId, debouncedSearch, page, requestKey])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20" />
      <div
        className="relative bg-white rounded-xl shadow-xl border border-[var(--line)] w-full max-w-md overflow-hidden flex flex-col"
        style={{ maxHeight: 'calc(100vh - 120px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--line)] shrink-0">
          <p className="text-xs font-medium text-[var(--muted)] mb-2">Choose an example product</p>
          <input
            type="search"
            placeholder="Search title, vendor, handle, tags…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="w-full px-3 py-2 rounded-lg border border-[var(--line)] text-sm focus:border-[var(--accent-ink)] focus:outline-none focus:ring-2 focus:ring-[rgba(39,67,214,0.15)]"
          />
        </div>
        <div
          className="overflow-y-auto"
          style={{ flex: 1, opacity: loading && products.length > 0 ? 0.6 : 1 }}
        >
          {loading && products.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--muted)] opacity-70">Loading products…</div>
          ) : products.length === 0 ? (
            <div className="p-8 text-center text-sm text-[var(--muted)] opacity-70">
              {debouncedSearch ? 'No products match your search' : 'No products found'}
            </div>
          ) : (
            products.map((p) => (
              <button
                key={p.id}
                onClick={() => onSelect(p)}
                className="w-full text-left px-4 py-3 hover:bg-[var(--tint)] border-b border-[var(--line)] transition-colors flex items-center gap-3"
              >
                {(p.images[0]?.src as string | undefined) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.images[0].src as string}
                    alt=""
                    className="w-8 h-8 rounded object-cover shrink-0 border border-[var(--line)]"
                  />
                ) : (
                  <div className="w-8 h-8 rounded bg-[var(--card-2)] shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[var(--ink)] truncate">{p.title}</div>
                  <div className="text-xs text-[var(--muted)] opacity-70 font-mono truncate mt-0.5">{p.handle}</div>
                </div>
              </button>
            ))
          )}
        </div>
        {total > 0 && (
          <div
            className="px-4 py-2.5 flex items-center justify-between gap-2 shrink-0"
            style={{ borderTop: '1px solid var(--hairline)' }}
          >
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={loading || page <= 1}
              className="ff-btn-secondary"
            >
              Previous
            </button>
            <span style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
              Page {page} of {totalPages} · {total} products
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={loading || page >= totalPages}
              className="ff-btn-secondary"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── AI Suggestions Modal ───────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: AISuggestion['confidence'] }) {
  const styles = {
    high:   'bg-[var(--good-bg)] text-[var(--good)]',
    medium: 'bg-[var(--warn-bg)] text-[var(--warn)]',
    low:    'bg-[var(--card-2)] text-[var(--muted)]',
  }
  const labels = { high: 'High', medium: 'Medium', low: 'Low' }
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${styles[confidence]}`}>
      {labels[confidence]}
    </span>
  )
}

function AISuggestionsModal({
  suggestions,
  currentMappings,
  onApply,
  onClose,
}: {
  suggestions: AISuggestion[]
  currentMappings: Record<string, FieldState>
  onApply: (selectedFields: string[]) => void
  onClose: () => void
}) {
  function isSameAsCurrent(s: AISuggestion): boolean {
    const state = currentMappings[s.google_field]
    if (!state?.type) return false
    if (s.mapping_type === 'static') {
      return state.type === 'STATIC' && String(state.config.value ?? '') === (s.static_value ?? '')
    }
    return state.type === 'FIELD' && String(state.config.field ?? '') === (s.shopify_field ?? '')
  }

  const validSuggestions = suggestions.filter((s) => ALL_FIELDS.includes(s.google_field))

  const [selected, setSelected] = useState<Set<string>>(() => {
    const init = new Set<string>()
    for (const s of validSuggestions) {
      if (s.confidence === 'high' && !isSameAsCurrent(s)) {
        init.add(s.google_field)
      }
    }
    return init
  })

  function toggle(field: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(field)) next.delete(field)
      else next.add(field)
      return next
    })
  }

  const selectableCount = validSuggestions.filter((s) => !isSameAsCurrent(s)).length

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/30" />
      <div
        className="relative bg-white rounded-xl shadow-xl border border-[var(--line)] w-full max-w-2xl flex flex-col max-h-[85vh] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-[var(--line)] shrink-0">
          <h2 className="text-base font-semibold text-[var(--ink)]">AI mapping suggestions</h2>
          <p className="text-sm text-[var(--muted)] mt-0.5">
            {validSuggestions.length} suggestions · {selectableCount} can be applied
          </p>
        </div>

        {/* List */}
        <div className="overflow-y-auto flex-1">
          {validSuggestions.length === 0 ? (
            <p className="p-8 text-center text-sm text-[var(--muted)] opacity-70">
              AI found no confident mapping suggestions for your shop.
            </p>
          ) : (
            validSuggestions.map((s) => {
              const same = isSameAsCurrent(s)
              const hasMapped = !!currentMappings[s.google_field]?.type
              const willOverwrite = hasMapped && !same

              return (
                <label
                  key={s.google_field}
                  className={`flex items-start gap-3 px-6 py-3.5 border-b border-[var(--line)] transition-colors ${
                    same ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-[var(--canvas-2)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={!same && selected.has(s.google_field)}
                    disabled={same}
                    onChange={() => { if (!same) toggle(s.google_field) }}
                    className="mt-0.5 rounded border-[var(--line)] text-[var(--accent-ink)] focus:ring-[var(--accent-ink)] shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono text-[var(--ink)] bg-[var(--card-2)] px-1.5 py-0.5 rounded">
                        {s.google_field}
                      </code>
                      <span className="text-[var(--muted)] opacity-70 text-sm">→</span>
                      {s.mapping_type === 'static' ? (
                        <code className="text-xs font-mono text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                          Static: &quot;{s.static_value ?? ''}&quot;
                        </code>
                      ) : (
                        <code className="text-xs font-mono text-[var(--tint-fg)] bg-[var(--tint)] px-1.5 py-0.5 rounded">
                          {s.shopify_field ?? '—'}
                        </code>
                      )}
                      <ConfidenceBadge confidence={s.confidence} />
                      {same && (
                        <span className="text-xs bg-[var(--card-2)] text-[var(--muted)] px-1.5 py-0.5 rounded">
                          Same as now
                        </span>
                      )}
                      {willOverwrite && (
                        <span className="text-xs bg-[var(--warn-bg)] text-[var(--warn)] border border-[var(--warn-bg)] px-1.5 py-0.5 rounded">
                          Overwrites existing mapping
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--muted)] mt-1">{s.reason}</p>
                  </div>
                </label>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--line)] flex items-center justify-between shrink-0">
          <span className="text-sm text-[var(--muted)]">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-[var(--line)] text-sm text-[var(--muted)] hover:bg-[var(--canvas-2)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onApply([...selected])}
              disabled={selected.size === 0}
              className="px-4 py-2 rounded-lg bg-[var(--accent-ink)] text-white text-sm font-medium hover:bg-[var(--accent-ink)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Apply {selected.size > 0 ? `${selected.size} ` : ''}selected
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── SectionPanel ───────────────────────────────────────────────────────────

// Renders a single mapping section. Supports two modes:
//   - static (collapsible=false): always-open header (used for required +
//     tilføjede felter)
//   - collapsible: header is a button that toggles open/closed
function SectionPanel({
  title,
  fields,
  totalFields,
  mappings,
  allFields,
  onTypeChange,
  onConfigChange,
  previewProduct,
  previewValues,
  onPreview,
  collapsible = false,
  open = true,
  onToggle,
  required = false,
}: {
  title: string
  // The fields to show (after search/filter).
  fields: string[]
  // Every field in the group, for the "X/Y mappet" count and the closed summary.
  totalFields: string[]
  mappings: Record<string, FieldState>
  allFields: string[]
  onTypeChange: (field: string, type: MappingType) => void
  onConfigChange: (field: string, config: Config) => void
  previewProduct: PreviewProduct | null
  previewValues: Record<string, string | null>
  onPreview: (field: string) => void
  collapsible?: boolean
  open?: boolean
  onToggle?: () => void
  required?: boolean
}) {
  const isMapped = (f: string) => !!mappings[f]?.type
  const mapped = totalFields.filter(isMapped).length
  const missing = required ? totalFields.filter((f) => !isMapped(f)).length : 0

  const head = (
    <>
      {collapsible && <Icon name="chevron" size={13} className="mp-chev" />}
      <span className="mp-group-t">
        <b>{title}</b>
        {!open && <small>{totalFields.join(' · ')}</small>}
      </span>
      {missing > 0 && <span className="pill bad">{missing} missing</span>}
      <span className="mp-count">
        {mapped}/{totalFields.length} mapped
      </span>
    </>
  )

  return (
    <div className="mp-group" data-open={open}>
      {collapsible ? (
        <button type="button" onClick={onToggle} className="mp-group-h" aria-expanded={open}>
          {head}
        </button>
      ) : (
        <div className="mp-group-h mp-static">{head}</div>
      )}
      {open && (
        <div className="mp-rows">
          {fields.map((field) => (
            <FieldRow
              key={field}
              field={field}
              state={mappings[field] ?? { type: '', config: {} }}
              allFields={allFields}
              onTypeChange={(type) => onTypeChange(field, type)}
              onConfigChange={(config) => onConfigChange(field, config)}
              previewValue={previewProduct ? (previewValues[field] ?? null) : null}
              onPreview={() => onPreview(field)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── CustomFieldsSection ────────────────────────────────────────────────────

// Renders the "Custom felter" panel: list of user-defined fields (with the
// "custom:" prefix kept on the underlying mapping key) plus an inline
// add-form. Validation rules: alphanumeric + underscore only, no spaces.
function CustomFieldsSection({
  customFields,
  mappings,
  allFields,
  onTypeChange,
  onConfigChange,
  previewProduct,
  previewValues,
  onAdd,
  onRemove,
  onPreview,
}: {
  customFields: string[]
  mappings: Record<string, FieldState>
  allFields: string[]
  onTypeChange: (field: string, type: MappingType) => void
  onConfigChange: (field: string, config: Config) => void
  previewProduct: PreviewProduct | null
  previewValues: Record<string, string | null>
  onAdd: (rawName: string) => string | null
  onRemove: (field: string) => void
  onPreview: (field: string) => void
}) {
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mappedCount = customFields.filter((f) => mappings[f]?.type !== '' && mappings[f]?.type).length

  function tryAdd() {
    const err = onAdd(name)
    if (err) {
      setError(err)
      return
    }
    setName('')
    setError(null)
    setShowAdd(false)
  }

  function cancelAdd() {
    setShowAdd(false)
    setName('')
    setError(null)
  }

  return (
    <div className="card flush mp-card">
      <div className="mp-group-h mp-static">
        <span className="mp-group-t">
          <b>Custom fields</b>
          <small>Fields outside the Google standard, written to the feed with the name you give them.</small>
        </span>
        <span className="mp-count">{mappedCount}/{customFields.length} mapped</span>
      </div>
      <div
        style={{ borderColor: 'var(--hairline)' }}
        className="divide-y divide-[color:rgba(26,26,24,0.13)]"
      >
        {customFields.length === 0 && !showAdd && (
          <div
            className="px-3.5 py-3"
            style={{ fontSize: '11px', color: 'var(--ink-muted)' }}
          >
            No custom fields yet. Add fields that aren’t in the Google Shopping standard.
            They’re written to the feed without the prefix <code className="ff-mono">g:</code>.
          </div>
        )}

        {customFields.map((field) => (
          <FieldRow
            key={field}
            field={field}
            state={mappings[field] ?? { type: '', config: {} }}
            allFields={allFields}
            onTypeChange={(type) => onTypeChange(field, type)}
            onConfigChange={(config) => onConfigChange(field, config)}
            previewValue={previewProduct ? (previewValues[field] ?? null) : null}
            onRemove={() => onRemove(field)}
            onPreview={() => onPreview(field)}
          />
        ))}

        {showAdd ? (
          <div className="px-3.5 py-3 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (error) setError(null)
                }}
                placeholder="e.g. vintage_year"
                className={`${inp} ff-mono`}
                style={{ flex: '1 1 280px', minWidth: 0, maxWidth: '320px' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    tryAdd()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelAdd()
                  }
                }}
              />
              <button type="button" onClick={tryAdd} className="ff-btn-primary">
                Add
              </button>
              <button type="button" onClick={cancelAdd} className="ff-btn-secondary">
                Cancel
              </button>
            </div>
            {error && (
              <p style={{ fontSize: '11px', color: 'var(--accent-red)' }}>{error}</p>
            )}
            <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
              Letters, numbers and underscores only. The field is written to the XML as{' '}
              <code className="ff-mono">{`<${name.trim() || 'field_name'}>…</${name.trim() || 'field_name'}>`}</code>
            </p>
          </div>
        ) : (
          <div className="px-3.5 py-2.5">
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="ff-btn-secondary"
            >
              ＋ Add custom field
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── AddFieldModal ──────────────────────────────────────────────────────────

function AddFieldModal({
  addedFields,
  onAdd,
  onRemove,
  onClose,
}: {
  addedFields: string[]
  onAdd: (field: string) => void
  onRemove: (field: string) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const addedSet = new Set(addedFields)
  const q = search.trim().toLowerCase()

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      onClick={onClose}
    >
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.3)' }} />
      <div
        className="relative ff-panel w-full"
        style={{
          maxWidth: '640px',
          maxHeight: 'calc(100vh - 96px)',
          display: 'flex',
          flexDirection: 'column',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="ff-panel-header"
          style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px' }}
        >
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>
            Add field
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              fontSize: '16px',
              lineHeight: 1,
              color: 'var(--ink-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        <div className="px-3.5 py-3" style={{ borderBottom: '1px solid var(--hairline)' }}>
          <input
            type="search"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search fields…"
            className={inp}
          />
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {ADVANCED_CATEGORIES.map((category) => {
            const matching = q
              ? category.fields.filter((f) => f.toLowerCase().includes(q))
              : category.fields
            if (matching.length === 0) return null
            return (
              <div key={category.title}>
                <div
                  className="ff-label"
                  style={{
                    padding: '8px 14px',
                    background: 'var(--bg-surface)',
                    borderTop: '1px solid var(--hairline)',
                    borderBottom: '1px solid var(--hairline)',
                  }}
                >
                  {category.title}
                </div>
                {matching.map((field) => {
                  const isAdded = addedSet.has(field)
                  return (
                    <div
                      key={field}
                      className="flex items-center justify-between gap-3"
                      style={{
                        padding: '8px 14px',
                        borderBottom: '1px solid var(--hairline)',
                      }}
                    >
                      <code
                        className="ff-mono"
                        style={{ fontSize: '11px', color: 'var(--ink)' }}
                      >
                        {field}
                      </code>
                      {isAdded ? (
                        <button
                          type="button"
                          onClick={() => onRemove(field)}
                          className="ff-btn-secondary"
                          style={{ color: 'var(--accent-red)' }}
                        >
                          Remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onAdd(field)}
                          className="ff-btn-primary"
                        >
                          Add
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>

        <div
          className="px-3.5 py-3 flex justify-end"
          style={{ borderTop: '1px solid var(--hairline)' }}
        >
          <button type="button" onClick={onClose} className="ff-btn-secondary">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── FieldPreviewSidebar ────────────────────────────────────────────────────

// All filtering, searching and pagination is delegated to /api/products. The
// sidebar holds 20 products at a time and steps with Forrige/Næste.

type FilterKey =
  | 'vendor'
  | 'product_type'
  | 'status'
  | 'in_stock'
  | 'tags'
  | 'sku'
  | 'title'
  | 'handle'
  | 'price_gt'
  | 'price_lt'

type FilterDef = {
  key: FilterKey
  label: string
  kind: 'text' | 'number' | 'select'
  placeholder?: string
  options?: { value: string; label: string }[]
  formatChip: (value: string) => string
}

const FILTER_DEFS: FilterDef[] = [
  {
    key: 'vendor',
    label: 'Vendor',
    kind: 'text',
    placeholder: 'e.g. Acme Ltd',
    formatChip: (v) => `Vendor: ${v}`,
  },
  {
    key: 'product_type',
    label: 'Product type',
    kind: 'text',
    placeholder: 'e.g. Wine',
    formatChip: (v) => `Product type: ${v}`,
  },
  {
    key: 'status',
    label: 'Status',
    kind: 'select',
    options: [
      { value: 'active', label: 'Active' },
      { value: 'inactive', label: 'Inactive' },
    ],
    formatChip: (v) => `Status: ${v === 'active' ? 'Active' : 'Inactive'}`,
  },
  {
    key: 'in_stock',
    label: 'Stock status',
    kind: 'select',
    options: [
      { value: 'true', label: 'In stock' },
      { value: 'false', label: 'Out of stock' },
    ],
    formatChip: (v) =>
      `Stock status: ${v === 'true' ? 'In stock' : 'Out of stock'}`,
  },
  {
    key: 'tags',
    label: 'Tags contain',
    kind: 'text',
    placeholder: 'e.g. vintage',
    formatChip: (v) => `Tags contain: ${v}`,
  },
  {
    key: 'price_gt',
    label: 'Price greater than',
    kind: 'number',
    placeholder: 'e.g. 100',
    formatChip: (v) => `Price > ${v}`,
  },
  {
    key: 'price_lt',
    label: 'Price less than',
    kind: 'number',
    placeholder: 'e.g. 500',
    formatChip: (v) => `Price < ${v}`,
  },
  {
    key: 'sku',
    label: 'SKU contains',
    kind: 'text',
    placeholder: 'e.g. ABC',
    formatChip: (v) => `SKU contains: ${v}`,
  },
  {
    key: 'title',
    label: 'Title contains',
    kind: 'text',
    placeholder: 'e.g. vintage',
    formatChip: (v) => `Title contains: ${v}`,
  },
  {
    key: 'handle',
    label: 'Handle contains',
    kind: 'text',
    placeholder: 'e.g. red-shirt',
    formatChip: (v) => `Handle contains: ${v}`,
  },
]

const SIDEBAR_PAGE_SIZE = 20

function FieldPreviewSidebar({
  field,
  state,
  feedId,
  feedMode,
  marketUrl,
  onClose,
}: {
  field: string
  state: FieldState
  feedId: string
  feedMode: 'product' | 'variant'
  marketUrl: string | null
  onClose: () => void
}) {
  // Every field's current state, so `feed:` references preview correctly.
  const allMappings = useContext(MappingsContext)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [filters, setFilters] = useState<Partial<Record<FilterKey, string>>>({})
  const [products, setProducts] = useState<PreviewProduct[]>([])
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(1)
  const [page, setPage] = useState(1)
  // Key of the last request that settled; loading = current key not settled yet.
  const [settledKey, setSettledKey] = useState<string | null>(null)

  // 'menu' = filter-type picker open; FilterKey = editing that filter's value.
  const [adding, setAdding] = useState<null | 'menu' | FilterKey>(null)

  // Debounce free-text search → committed query.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // Reset to page 1 whenever search or filters change so the user doesn't
  // land on an out-of-range page after narrowing.
  // (adjust state during render when search or filters change).
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters])
  const resetKey = JSON.stringify([debouncedSearch, filtersKey])
  const [prevResetKey, setPrevResetKey] = useState(resetKey)
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey)
    setPage(1)
  }

  const requestKey = JSON.stringify([feedId, debouncedSearch, filtersKey, page])
  const loading = settledKey !== requestKey

  // Esc closes the panel (when no inline editor is open).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (adding) setAdding(null)
        else onClose()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose, adding])

  // Fetch products — server-side search, filter and pagination.
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({
      feedId,
      page: String(page),
      pageSize: String(SIDEBAR_PAGE_SIZE),
    })
    if (debouncedSearch) params.set('search', debouncedSearch)
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.set(k, v)
    }

    fetch(`/api/products?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return (await res.json()) as {
          products?: PreviewProduct[]
          total?: number
          totalPages?: number
        }
      })
      .then((data) => {
        if (cancelled) return
        setProducts(data.products ?? [])
        setTotal(data.total ?? 0)
        setTotalPages(Math.max(1, data.totalPages ?? 1))
      })
      .catch(() => {
        if (!cancelled) {
          setProducts([])
          setTotal(0)
          setTotalPages(1)
        }
      })
      .finally(() => {
        if (!cancelled) setSettledKey(requestKey)
      })

    return () => {
      cancelled = true
    }
  }, [feedId, debouncedSearch, filters, page, requestKey])

  function applyFilter(key: FilterKey, value: string) {
    if (!value) return
    setFilters((prev) => ({ ...prev, [key]: value }))
    setAdding(null)
  }
  function removeFilter(key: FilterKey) {
    setFilters((prev) => {
      const { [key]: _removed, ...rest } = prev
      return rest
    })
  }

  const hasMapping = state.type !== ''

  let mappingLabel = 'No mapping'
  if (state.type === 'FIELD') mappingLabel = `FIELD → ${(state.config.field as string) ?? ''}`
  else if (state.type === 'STATIC')
    mappingLabel = `STATIC → "${(state.config.value as string) ?? ''}"`
  else if (state.type) mappingLabel = state.type

  // Spell out the layers stacked on the mapping, so the values below aren't
  // unexplained — they are what the rules and filters produced, not the raw field.
  const sidebarRules = (state.config.onlyIf as OnlyIf | undefined)?.rules?.length ?? 0
  const sidebarTransforms = configTransforms(state.config).length
  const layerNotes: string[] = []
  if (sidebarRules > 0) layerNotes.push(`${sidebarRules + 1} rules`)
  if (sidebarTransforms > 0) {
    layerNotes.push(`${sidebarTransforms} format${sidebarTransforms > 1 ? 's' : ''}`)
  }
  if (layerNotes.length > 0) mappingLabel += ` · ${layerNotes.join(' · ')}`

  const displayField = field.startsWith('custom:') ? field.slice('custom:'.length) : field

  const activeFilterEntries = Object.entries(filters).filter(([, v]) => v) as [
    FilterKey,
    string,
  ][]
  const availableForAdding = FILTER_DEFS.filter((d) => !filters[d.key])

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.3)' }}
        onClick={onClose}
      />
      <aside
        className="fixed top-0 right-0 z-50 h-screen flex flex-col"
        style={{
          width: '50vw',
          minWidth: '440px',
          maxWidth: '100vw',
          background: '#ffffff',
          borderLeft: '1px solid var(--hairline)',
          boxShadow: '-2px 0 12px rgba(0,0,0,0.06)',
        }}
      >
        {/* Header */}
        <div
          className="px-3.5 py-3 flex items-start justify-between gap-2"
          style={{ borderBottom: '1px solid var(--hairline)' }}
        >
          <div className="min-w-0">
            <code
              className="ff-mono"
              style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}
            >
              {displayField}
            </code>
            <p
              className="mt-0.5"
              style={{ fontSize: '11px', color: 'var(--ink-muted)' }}
            >
              {mappingLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            style={{
              fontSize: '18px',
              lineHeight: 1,
              color: 'var(--ink-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '2px 6px',
            }}
          >
            ×
          </button>
        </div>

        {/* Search + active filter chips + add-filter UI */}
        <div
          className="px-3.5 py-3 space-y-2"
          style={{ borderBottom: '1px solid var(--hairline)' }}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, vendor, handle, tags…"
            className={inp}
          />

          {activeFilterEntries.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {activeFilterEntries.map(([key, value]) => {
                const def = FILTER_DEFS.find((d) => d.key === key)
                if (!def) return null
                return (
                  <span
                    key={key}
                    className="ff-badge ff-badge-accent"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <span>{def.formatChip(value)}</span>
                    <button
                      type="button"
                      onClick={() => removeFilter(key)}
                      aria-label={`Remove the ${def.label} filter`}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        padding: 0,
                        fontSize: '12px',
                        lineHeight: 1,
                        opacity: 0.7,
                      }}
                    >
                      ×
                    </button>
                  </span>
                )
              })}
            </div>
          )}

          {adding === null && availableForAdding.length > 0 && (
            <button
              type="button"
              onClick={() => setAdding('menu')}
              className="ff-btn-secondary"
              style={{ fontSize: '11px' }}
            >
              ＋ Add filter
            </button>
          )}

          {adding === 'menu' && (
            <div
              className="ff-panel"
              style={{
                background: '#ffffff',
                border: '1px solid var(--hairline)',
                borderRadius: '6px',
                maxHeight: '220px',
                overflowY: 'auto',
              }}
            >
              {availableForAdding.map((def) => (
                <button
                  key={def.key}
                  type="button"
                  onClick={() => setAdding(def.key)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    fontSize: '11px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--ink)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-surface)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {def.label}
                </button>
              ))}
            </div>
          )}

          {adding && adding !== 'menu' && (
            <FilterValueEditor
              def={FILTER_DEFS.find((d) => d.key === adding)!}
              onConfirm={(value) => applyFilter(adding, value)}
              onCancel={() => setAdding(null)}
            />
          )}
        </div>

        {/* Result count */}
        <div
          className="px-3.5 py-2"
          style={{
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--hairline)',
            fontSize: '11px',
            color: 'var(--ink-muted)',
          }}
        >
          {loading && products.length === 0
            ? 'Loading…'
            : `${total} products · page ${page} of ${totalPages}`}
        </div>

        {/* List */}
        <div style={{ overflowY: 'auto', flex: 1, opacity: loading ? 0.6 : 1 }}>
          {products.length === 0 && !loading ? (
            <p
              className="px-3.5 py-6 text-center"
              style={{ fontSize: '11px', color: 'var(--ink-muted)' }}
            >
              No products match
            </p>
          ) : (
            products.map((p) => {
              const value = hasMapping
                ? computePreviewValue(field, { ...allMappings, [field]: state }, p, marketUrl, feedMode)
                : ''
              return (
                <div
                  key={p.id}
                  className="px-3.5 py-2.5 flex items-start gap-3"
                  style={{ borderBottom: '1px solid var(--hairline)' }}
                >
                  <div className="min-w-0" style={{ flex: '1 1 45%' }}>
                    <p
                      className="truncate"
                      style={{ fontSize: '12px', color: 'var(--ink)' }}
                      title={p.title}
                    >
                      {p.title || '—'}
                    </p>
                    <p
                      className="ff-mono mt-0.5 truncate"
                      style={{ fontSize: '10px', color: 'var(--ink-muted)' }}
                    >
                      {p.handle}
                    </p>
                  </div>
                  <div
                    className="ff-mono"
                    style={{
                      fontSize: '11px',
                      // Long values (descriptions) need room to breathe; the
                      // basis keeps short scalar values in a tidy right column.
                      flex: '1 1 55%',
                      minWidth: 0,
                    }}
                  >
                    {value === '' ? (
                      <span
                        className="block text-right"
                        style={{
                          color: 'var(--ink-muted)',
                          fontStyle: 'italic',
                        }}
                      >
                        —
                      </span>
                    ) : value === AI_PLACEHOLDER ? (
                      <span className="ff-badge ff-badge-accent">AI</span>
                    ) : (
                      <div style={{ color: 'var(--accent-ink)' }}>
                        <PreviewValueText value={value} align="right" />
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Pagination */}
        <div
          className="px-3.5 py-2.5 flex items-center justify-between gap-2"
          style={{ borderTop: '1px solid var(--hairline)' }}
        >
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={loading || page <= 1}
            className="ff-btn-secondary"
          >
            Previous
          </button>
          <span style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={loading || page >= totalPages}
            className="ff-btn-secondary"
          >
            Next
          </button>
        </div>
      </aside>
    </>
  )
}

function FilterValueEditor({
  def,
  onConfirm,
  onCancel,
}: {
  def: FilterDef
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')

  function tryConfirm() {
    const v = value.trim()
    if (!v) return
    onConfirm(v)
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 p-2"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--hairline)',
        borderRadius: '6px',
      }}
    >
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          color: 'var(--ink-secondary)',
          flexShrink: 0,
        }}
      >
        {def.label}
      </span>
      {def.kind === 'select' ? (
        <select
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={sel}
          style={{ flex: '1 1 120px', minWidth: 0 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              tryConfirm()
            }
          }}
        >
          <option value="">— Choose —</option>
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={def.kind === 'number' ? 'number' : 'text'}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={def.placeholder}
          className={inp}
          style={{ flex: '1 1 120px', minWidth: 0 }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              tryConfirm()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />
      )}
      <button
        type="button"
        onClick={tryConfirm}
        disabled={!value.trim()}
        className="ff-btn-primary"
      >
        Add
      </button>
      <button type="button" onClick={onCancel} className="ff-btn-secondary">
        Cancel
      </button>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

type InitialMapping = {
  google_field: string
  mapping_type: string
  config: Config
}

export default function MappingClient({
  feedId,
  feedMode,
  initialMappings,
}: {
  feedId: string
  feedMode: 'product' | 'variant'
  initialMappings: InitialMapping[]
}) {
  // Metafields load progressively (LAG 2). Field-selector dropdowns render
  // with standard Shopify fields immediately and gain metafield options once
  // the paginated scan returns. Saved mappings that reference metafields are
  // unaffected — they round-trip through their stored "metafield:..." keys.
  const [metafields, setMetafields] = useState<
    { namespace: string; key: string; name?: string }[]
  >([])
  useEffect(() => {
    let cancelled = false
    fetch(`/api/mapping/metafields?feedId=${encodeURIComponent(feedId)}`)
      .then((r) => r.json())
      .then((data: { metafields?: { namespace: string; key: string; name?: string }[] }) => {
        if (cancelled) return
        setMetafields(data.metafields ?? [])
      })
      .catch(() => {
        // Non-fatal — the dropdown stays standard-fields-only.
      })
    return () => {
      cancelled = true
    }
  }, [feedId])

  const [mappings, setMappings] = useState<Record<string, FieldState>>(() => {
    const init: Record<string, FieldState> = {}
    for (const f of ALL_FIELDS) init[f] = { type: '', config: {} }
    for (const m of initialMappings) {
      const isCustom = m.google_field.startsWith('custom:')
      // Accept Google fields we know about plus any custom field. Unknown
      // Google-namespace fields are skipped (legacy data).
      if (!isCustom && !ALL_FIELDS.includes(m.google_field)) continue
      let cfg: Config = {}
      try {
        const raw = m.config
        cfg = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as Config
      } catch {
        console.warn(`Kunne ikke parse config for ${m.google_field}:`, m.config)
      }
      init[m.google_field] = { type: m.mapping_type as MappingType, config: cfg }
    }
    return init
  })

  // Custom user-defined fields (stored with "custom:" prefix in the DB).
  // Auto-seeded from initialMappings so saved custom fields show up on next
  // load. removedCustomFields holds keys that the user has × deleted in this
  // session — they're sent with empty mapping_type on save so the DB row
  // disappears, then cleared on success.
  const [customFields, setCustomFields] = useState<string[]>(() => {
    const set = new Set<string>()
    for (const m of initialMappings) {
      if (m.google_field.startsWith('custom:') && m.mapping_type !== '') {
        set.add(m.google_field)
      }
    }
    return Array.from(set)
  })
  const [removedCustomFields, setRemovedCustomFields] = useState<string[]>([])

  function addCustomField(rawName: string): string | null {
    const trimmed = rawName.trim()
    if (!trimmed) return 'The field name can’t be empty'
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return 'Letters, numbers and underscores only. No spaces or special characters.'
    }
    const fullKey = `custom:${trimmed}`
    if (customFields.includes(fullKey)) return 'The field already exists'
    setCustomFields((prev) => [...prev, fullKey])
    setMappings((prev) => ({ ...prev, [fullKey]: { type: '', config: {} } }))
    setRemovedCustomFields((prev) => prev.filter((f) => f !== fullKey))
    return null
  }

  function removeCustomField(field: string) {
    setCustomFields((prev) => prev.filter((f) => f !== field))
    setRemovedCustomFields((prev) => (prev.includes(field) ? prev : [...prev, field]))
  }

  const [isPending, startTransition] = useTransition()
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  // Patterns the last save stored but the generator will skip. Kept until the
  // next save (not timed out like "Saved") — it's something to go fix.
  const [saveWarnings, setSaveWarnings] = useState<string[]>([])

  // ── Section / "added fields" state ──────────────────────────────────────
  // Advanced fields the user has explicitly surfaced via the "+ Tilføj felt"
  // modal. Seeded from initialMappings so a saved-but-advanced mapping shows
  // up automatically on next load.
  const [addedFields, setAddedFields] = useState<string[]>(() => {
    const seen = new Set<string>()
    for (const m of initialMappings) {
      if (m.mapping_type !== '' && ADVANCED_FIELDS.includes(m.google_field)) {
        seen.add(m.google_field)
      }
    }
    return Array.from(seen)
  })

  // Collapsible-section open state. Auto-opens any section that contains a
  // field with a saved mapping; otherwise the section starts collapsed.
  const [openSections, setOpenSections] = useState<Set<string>>(() => {
    const mappedSet = new Set(
      initialMappings.filter((m) => m.mapping_type !== '').map((m) => m.google_field)
    )
    const open = new Set<string>()
    for (const section of COLLAPSIBLE_SECTIONS) {
      if (section.fields.some((f) => mappedSet.has(f))) open.add(section.title)
    }
    return open
  })

  const [showAddFieldModal, setShowAddFieldModal] = useState(false)

  // Field preview sidebar — set to a Google field name when the user clicks
  // the hover "Preview" button on a row; null when the sidebar is closed.
  const [previewSidebarField, setPreviewSidebarField] = useState<string | null>(null)

  function toggleSection(title: string) {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  function addField(field: string) {
    setAddedFields((prev) => (prev.includes(field) ? prev : [...prev, field]))
  }

  function removeAddedField(field: string) {
    setAddedFields((prev) => prev.filter((f) => f !== field))
    // Also clear the saved mapping so the next save deletes it from the DB.
    setMappings((prev) => ({ ...prev, [field]: { type: '', config: {} } }))
  }

  // ── AI auto-mapping state ────────────────────────────────────────────────
  const [isFetchingAI, setIsFetchingAI] = useState(false)
  const [aiError, setAIError] = useState<string | null>(null)
  const [aiSuggestions, setAISuggestions] = useState<AISuggestion[] | null>(null)
  const [showAIModal, setShowAIModal] = useState(false)

  async function fetchAISuggestions() {
    setIsFetchingAI(true)
    setAIError(null)
    try {
      // Live mappings — includes the user's unsaved edits. Only the active
      // (non-empty mapping_type) entries are sent so the AI knows which
      // fields are off-limits.
      const existingMappings = Object.entries(mappings)
        .filter(([, state]) => state.type !== '')
        .map(([field, state]) => ({
          google_field: field,
          mapping_type: state.type,
          config: state.config,
        }))
      const mappedSet = new Set(existingMappings.map((m) => m.google_field))

      const res = await fetch(
        `/api/mapping/ai-suggest?feedId=${encodeURIComponent(feedId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ existingMappings }),
        }
      )
      const data = (await res.json()) as { suggestions?: AISuggestion[]; error?: string }
      if (data.error) throw new Error(data.error)

      // Defense in depth: drop suggestions for fields already mapped, even if
      // the route filter missed something.
      const filtered = (data.suggestions ?? []).filter((s) => !mappedSet.has(s.google_field))
      setAISuggestions(filtered)
      setShowAIModal(true)
    } catch (err) {
      setAIError(err instanceof Error ? err.message : 'The AI analysis failed')
    } finally {
      setIsFetchingAI(false)
    }
  }

  function applySuggestions(selectedFields: string[]) {
    setMappings((prev) => {
      const next = { ...prev }
      for (const googleField of selectedFields) {
        const s = aiSuggestions!.find((x) => x.google_field === googleField)
        if (!s || !ALL_FIELDS.includes(s.google_field)) continue
        if (s.mapping_type === 'static' && s.static_value !== undefined) {
          next[s.google_field] = { type: 'STATIC', config: { value: s.static_value } }
        } else if (s.mapping_type === 'field' && s.shopify_field) {
          next[s.google_field] = { type: 'FIELD', config: { field: s.shopify_field } }
        }
      }
      return next
    })
    setShowAIModal(false)
    setAISuggestions(null)
    if (status !== 'idle') setStatus('idle')
  }

  // ── Preview state ────────────────────────────────────────────────────────
  const [previewProduct, setPreviewProduct] = useState<PreviewProduct | null>(null)
  const [showPicker, setShowPicker] = useState(false)
  const [showFieldsModal, setShowFieldsModal] = useState(false)
  const [allProducts, setAllProducts] = useState<PreviewProduct[]>([])
  const [loadingProducts, setLoadingProducts] = useState(false)
  const [marketUrl, setMarketUrlState] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/settings?feedId=${encodeURIComponent(feedId)}`)
      .then((r) => r.json())
      .then(
        (data: {
          settings?: { market_url?: string | null } | null
          primaryDomain?: string | null
        }) => {
          // Same precedence as the generated feed: market URL first, then the
          // project's own storefront domain.
          setMarketUrlState(data.settings?.market_url ?? data.primaryDomain ?? null)
        }
      )
      .catch(() => {})
  }, [feedId])

  async function ensureProducts() {
    if (allProducts.length > 0 || loadingProducts) return
    setLoadingProducts(true)
    try {
      const res = await fetch(`/api/products?feedId=${encodeURIComponent(feedId)}`)
      const data = await res.json() as { products: PreviewProduct[] }
      setAllProducts(data.products ?? [])
    } catch {
      // silently fail — user sees empty list
    } finally {
      setLoadingProducts(false)
    }
  }

  function openPicker() {
    setShowPicker(true)
    void ensureProducts()
  }

  function openFieldsModal() {
    setShowFieldsModal(true)
    void ensureProducts()
  }

  // Compute preview values for all fields whenever mappings or selected product change
  const previewValues = useMemo<Record<string, string | null>>(() => {
    if (!previewProduct) return {}
    const result: Record<string, string | null> = {}
    const fieldsToPreview = [...ALL_FIELDS, ...customFields]
    const ev = previewEvaluator(mappings, previewProduct, marketUrl, feedMode)
    for (const field of fieldsToPreview) {
      result[field] = mappings[field]?.type ? ev.value(field) ?? '' : null
    }
    return result
  }, [mappings, previewProduct, marketUrl, feedMode, customFields])

  // What config editors need beyond their own config (the EXTRACT editor shows
  // which pattern hits the preview product, and runs the coverage check).
  const editorContext = useMemo(
    () => ({ feedId, previewProduct, marketUrl }),
    [feedId, previewProduct, marketUrl]
  )

  // ── Field helpers ────────────────────────────────────────────────────────
  const allFields: string[] = [
    ...STANDARD_FIELDS,
    ...metafields.map((m) => `metafield:${m.namespace}.${m.key}`),
  ]

  // Token → readable definition name, for the field pickers (see context above).
  const metafieldLabels = useMemo(() => {
    const m = new Map<string, string>()
    for (const mf of metafields) {
      if (mf.name) m.set(`metafield:${mf.namespace}.${mf.key}`, mf.name)
    }
    return m
  }, [metafields])

  // Visible fields = required + collapsible + user-added advanced fields +
  // custom user-defined fields. The topbar denominator reflects what the
  // user can see in the UI, not every field ALL_FIELDS could in theory contain.
  const visibleFields = [...REQUIRED_FIELDS, ...COLLAPSIBLE_FIELDS, ...addedFields, ...customFields]
  const mappedCount = visibleFields.filter((f) => mappings[f]?.type !== '' && mappings[f]?.type).length
  const totalVisibleFields = visibleFields.length

  // Set of all Shopify fields referenced by at least one active mapping —
  // recomputed when mappings change. Drives the "Mappet"/"Ikke mappet" badges
  // in the Shopify-felter panel.
  const usedFieldsSet = useMemo(() => {
    const s = new Set<string>()
    for (const state of Object.values(mappings)) {
      if (!state.type) continue
      for (const f of collectUsedFields(state)) s.add(f)
    }
    return s
  }, [mappings])

  const fieldsModalProduct = previewProduct ?? allProducts[0] ?? null

  function updateType(field: string, type: MappingType) {
    setMappings((prev) => {
      const existing = prev[field]
      // The rule stack and the filter layer sit ON TOP of the mapping type, so
      // they survive a change of type — only the type's own config is reset.
      const carried: Config = {}
      if (existing?.config?.onlyIf) carried.onlyIf = existing.config.onlyIf
      const transforms = configTransforms(existing?.config)
      if (transforms.length > 0) carried.transforms = transforms
      // New Combines skip empty fields (no stray separators). Saved Combines
      // without the key keep plain concatenation, so no live feed changes.
      if (type === 'COMBINE') carried.skipEmpty = true
      return { ...prev, [field]: { type, config: carried } }
    })
    if (status !== 'idle') setStatus('idle')
  }

  function updateConfig(field: string, config: Config) {
    setMappings((prev) => ({ ...prev, [field]: { ...prev[field], config } }))
  }

  // ── Search + filter chips ────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<FieldChip>('all')
  const q = query.trim().toLowerCase()
  const filtering = q !== '' || chip !== 'all'

  function matchesChip(f: string, c: FieldChip): boolean {
    const st = mappings[f]
    switch (c) {
      case 'unmapped':
        return !st?.type
      case 'rules':
        return (
          !!st?.type &&
          (((st.config.onlyIf as OnlyIf | undefined)?.conditions?.some((x) => x.field) ?? false) ||
            configTransforms(st.config).length > 0)
        )
      case 'lookup':
        return st?.type === 'LOOKUP'
      case 'ai':
        return st?.type === 'AI'
      default:
        return true
    }
  }
  function fieldMatches(f: string): boolean {
    if (q && !f.replace(/^custom:/, '').toLowerCase().includes(q)) return false
    return matchesChip(f, chip)
  }
  const chipCount = (c: FieldChip) => visibleFields.filter((f) => matchesChip(f, c)).length

  const groups: { title: string; fields: string[]; required?: boolean; collapsible: boolean }[] = [
    { title: 'Required', fields: [...REQUIRED_FIELDS], required: true, collapsible: false },
    ...COLLAPSIBLE_SECTIONS.map((g) => ({ title: g.title, fields: g.fields, collapsible: true })),
    ...(addedFields.length > 0 ? [{ title: 'Added fields', fields: addedFields, collapsible: false }] : []),
  ]
  const shownGroups = groups
    .map((g) => ({ ...g, shown: g.fields.filter(fieldMatches) }))
    .filter((g) => !filtering || g.shown.length > 0)

  function handleSave() {
    startTransition(async () => {
      const entries: MappingEntry[] = [
        ...ALL_FIELDS.map((f) => ({
          google_field: f,
          mapping_type: mappings[f]?.type ?? '',
          config: mappings[f]?.config ?? {},
        })),
        ...customFields.map((f) => ({
          google_field: f,
          mapping_type: mappings[f]?.type ?? '',
          config: mappings[f]?.config ?? {},
        })),
        // × deleted custom fields — sent with empty mapping_type so saveMappings
        // deletes the existing DB row.
        ...removedCustomFields.map((f) => ({
          google_field: f,
          mapping_type: '',
          config: {},
        })),
      ]
      const result = await saveMappings(feedId, entries)
      if (result.error) {
        setErrorMsg(result.error)
        setStatus('error')
      } else {
        markFeedEdited(feedId)
        setSaveWarnings(result.warnings ?? [])
        setStatus('saved')
        setRemovedCustomFields([])
        setTimeout(() => setStatus('idle'), 2500)
      }
    })
  }

  return (
    <FeedModeContext.Provider value={feedMode}>
    <MetafieldLabelsContext.Provider value={metafieldLabels}>
    <MappingsContext.Provider value={mappings}>
    <EditorContext.Provider value={editorContext}>
    <div className="mp">
      <div className="mp-head">
        <div>
          <h1>Mapping</h1>
          <p className="mp-lede">
            Required fields are open. The rest are collapsed into groups. The icon shows what kind of
            field it is. {mappedCount} of {totalVisibleFields} fields are mapped.
          </p>
        </div>
        <div className="mp-actions">
          <button onClick={openFieldsModal} className="wl-btn-secondary">
            Shopify fields
          </button>
          <button onClick={fetchAISuggestions} disabled={isFetchingAI} className="wl-btn-secondary">
            <Icon name="bolt" size={14} />
            {isFetchingAI ? 'AI is analysing…' : 'Auto-map with AI'}
          </button>
          {previewProduct ? (
            <span className="mp-prodchip">
              {(previewProduct.images[0]?.src as string | undefined) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewProduct.images[0].src as string} alt="" />
              )}
              <span className="mp-prodchip-t">{previewProduct.title}</span>
              <button onClick={() => setPreviewProduct(null)} aria-label="Remove the example product">
                ×
              </button>
            </span>
          ) : (
            <button onClick={openPicker} className="wl-btn-secondary">
              <Icon name="eye" size={14} />
              Show on a product
            </button>
          )}
          <button onClick={handleSave} disabled={isPending} className="wl-btn-primary">
            {isPending ? 'Saving…' : status === 'saved' ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>

      {aiError && <p className="note warn">Couldn’t load the AI suggestions: {aiError}</p>}
      {status === 'error' && <p className="note warn">Couldn’t save the mapping: {errorMsg}</p>}
      {saveWarnings.length > 0 && (
        <div className="note warn mp-warnings" role="alert">
          <div>
            <b>Saved with warnings</b>
            {saveWarnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
          <button type="button" onClick={() => setSaveWarnings([])} className="ff-btn-ghost" aria-label="Dismiss warnings">
            ×
          </button>
        </div>
      )}

      <section className="card flush mp-card">
        <div className="mp-tools">
          <label className="mp-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a field, e.g. price or custom_label"
              aria-label="Find a field"
            />
          </label>
          <div className="mp-chips" role="group" aria-label="Filter fields">
            {FIELD_CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="mp-filter"
                aria-pressed={chip === c.id}
                onClick={() => setChip(c.id)}
              >
                {c.label} <b>{chipCount(c.id)}</b>
              </button>
            ))}
          </div>
        </div>

        {shownGroups.length === 0 ? (
          <p className="mp-none">No fields match. Try another filter.</p>
        ) : (
          shownGroups.map((g) => (
            <SectionPanel
              key={g.title}
              title={g.title}
              fields={g.shown}
              totalFields={g.fields}
              mappings={mappings}
              allFields={allFields}
              onTypeChange={updateType}
              onConfigChange={updateConfig}
              previewProduct={previewProduct}
              previewValues={previewValues}
              onPreview={setPreviewSidebarField}
              required={g.required}
              collapsible={g.collapsible && !filtering}
              open={filtering || !g.collapsible || openSections.has(g.title)}
              onToggle={() => toggleSection(g.title)}
            />
          ))
        )}

        <div className="mp-addrow">
          <button type="button" onClick={() => setShowAddFieldModal(true)} className="ff-btn-ghost">
            + Add field
          </button>
        </div>
      </section>

        {/* Custom (non-Google) fields — always rendered, sits at the bottom */}
        <CustomFieldsSection
          customFields={customFields}
          mappings={mappings}
          allFields={allFields}
          onTypeChange={updateType}
          onConfigChange={updateConfig}
          previewProduct={previewProduct}
          previewValues={previewValues}
          onAdd={addCustomField}
          onRemove={removeCustomField}
          onPreview={setPreviewSidebarField}
        />

      {showPicker && (
        <ProductPickerModal
          feedId={feedId}
          onSelect={(p) => {
            setPreviewProduct(p)
            setShowPicker(false)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}

      {showAIModal && aiSuggestions && (
        <AISuggestionsModal
          suggestions={aiSuggestions}
          currentMappings={mappings}
          onApply={applySuggestions}
          onClose={() => setShowAIModal(false)}
        />
      )}

      {showFieldsModal && (
        <ShopifyFieldsModal
          standardFields={STANDARD_FIELDS}
          metafields={metafields}
          product={fieldsModalProduct}
          loading={loadingProducts}
          marketUrl={marketUrl}
          usedFields={usedFieldsSet}
          onClose={() => setShowFieldsModal(false)}
        />
      )}

      {showAddFieldModal && (
        <AddFieldModal
          addedFields={addedFields}
          onAdd={addField}
          onRemove={removeAddedField}
          onClose={() => setShowAddFieldModal(false)}
        />
      )}

      {previewSidebarField && (
        <FieldPreviewSidebar
          field={previewSidebarField}
          state={mappings[previewSidebarField] ?? { type: '', config: {} }}
          feedId={feedId}
          feedMode={feedMode}
          marketUrl={marketUrl}
          onClose={() => setPreviewSidebarField(null)}
        />
      )}
    </div>
    </EditorContext.Provider>
    </MappingsContext.Provider>
    </MetafieldLabelsContext.Provider>
    </FeedModeContext.Provider>
  )
}
