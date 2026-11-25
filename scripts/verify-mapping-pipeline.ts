// Verifies the mapping value pipeline end to end, with no database and no
// Shopify connection: HTML -> text, the transform (filter) layer, and the
// top-down rule priority. Pure functions, so it runs anywhere.
//
// Run: npx tsx scripts/verify-mapping-pipeline.ts
//
// The entity anchors matter more than they look: LATIN1_ENTITIES is positional,
// so one missing name shifts every entity after it and turns "maaneder" into
// mojibake in every feed.
import { stripHtml, applyTransforms, LATIN1_ANCHORS } from '../lib/mappingTransforms'
import {
  selectBranchValue,
  combineBlocks,
  containsWord,
  evalCondition,
  type CombineBlock,
  type OnlyIf,
} from '../lib/mappingRules'
import { createItemEvaluator, type EvalMapping } from '../lib/mappingEval'
import { extractWithPatterns, patternError, patternProblems, type ExtractPattern } from '../lib/mappingExtract'

let fails = 0
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`)
}

// ── entity table ───────────────────────────────────────────────────────────
for (const [name, char] of LATIN1_ANCHORS) {
  eq(`entity &${name}; -> ${char}`, stripHtml(`<p>&${name};</p>`), char)
}

// ── stripHtml keeps line structure ─────────────────────────────────────────
const body =
  '<p>Vino Rosso 2019.</p>\n<p>Druer: <strong>Merlot</strong> &amp; Cabernet.</p>' +
  '<ul><li>Serveres ved 18&deg;C</li><li>Lagret 12 m&aring;neder</li></ul>' +
  '<p>Kraftig&nbsp;smag.<br>Lang eftersmag.</p>'

const bodyPlain =
  'Vino Rosso 2019.\nDruer: Merlot & Cabernet.\nServeres ved 18°C\n' +
  'Lagret 12 måneder\nKraftig smag.\nLang eftersmag.'

eq('stripHtml keeps paragraph + br + li breaks', stripHtml(body), bodyPlain)
eq('stripHtml collapses horizontal whitespace', stripHtml('<p>a     b</p>'), 'a b')
eq('stripHtml collapses empty paragraphs', stripHtml('<p>a</p><p></p><p></p><p>b</p>'), 'a\nb')
eq(
  'source formatting cannot change output',
  stripHtml('<p>a</p>\n   <p>b</p>'),
  stripHtml('<p>a</p><p>b</p>')
)
eq('stripHtml on empty input', stripHtml(''), '')
eq('stripHtml leaves unknown entities alone', stripHtml('<p>&zzz; &#65;</p>'), '&zzz; A')
eq('entity case is significant', stripHtml('<p>&Auml;&auml; &Oslash;&oslash;</p>'), 'Ää Øø')
eq('hex numeric entities', stripHtml('<p>&#xe5;&#XE5;</p>'), 'åå')
eq('astral numeric refs decode', stripHtml('<p>&#x1F600;</p>'), '\u{1F600}')
eq('stripHtml drops script bodies', stripHtml('<p>a</p><script>var x = 1;</script><p>b</p>'), 'a\nb')
eq('inline tags do not break the line', stripHtml('<p>a <em>b</em> c</p>'), 'a b c')

// ── transform stacking ─────────────────────────────────────────────────────
eq(
  'strip HTML then find & replace',
  applyTransforms(body, [
    { type: 'STRIP_HTML' },
    { type: 'FIND_REPLACE', pairs: [{ find: 'Merlot', replace: 'MERLOT' }] },
  ]),
  bodyPlain.replace('Merlot', 'MERLOT')
)
eq('order matters', applyTransforms('abcdef', [
  { type: 'TRUNCATE', maxChars: 3 },
  { type: 'PREFIX_SUFFIX', prefix: '[', suffix: ']' },
]), '[abc]')
eq('reverse order', applyTransforms('abcdef', [
  { type: 'PREFIX_SUFFIX', prefix: '[', suffix: ']' },
  { type: 'TRUNCATE', maxChars: 3 },
]), '[ab')
eq('empty find is skipped', applyTransforms('abc', [
  { type: 'FIND_REPLACE', pairs: [{ find: '', replace: 'X' }] },
]), 'abc')
eq('no transforms is identity', applyTransforms('abc', undefined), 'abc')
eq('prefix/suffix leaves empty value empty', applyTransforms('', [
  { type: 'PREFIX_SUFFIX', prefix: '[', suffix: ']' },
]), '')

// ── rule priority ──────────────────────────────────────────────────────────
const product: Record<string, string> = {
  price: '80',
  compare_at_price: '100',
  unit_price: '25',
  currency: 'DKK',
  vendor: 'Vino',
}
const resolve = (f: string) => product[f] ?? ''

const priceRules: OnlyIf = {
  // branch 0: on sale -> the mapping's own COMBINE value (compare_at_price)
  conditions: [{ field: 'price', operator: 'less_than_field', value: 'compare_at_price', logic: null }],
  rules: [
    {
      conditions: [{ field: 'unit_price', operator: 'is_not_empty', value: '', logic: null }],
      value: {
        type: 'combine',
        blocks: [
          { type: 'field', value: 'unit_price' },
          { type: 'text', value: ' ' },
          { type: 'field', value: 'currency' },
        ],
      },
    },
    {
      conditions: [{ field: 'vendor', operator: 'equals', value: 'Vino', logic: null }],
      value: { type: 'static', value: 'VINO FALLBACK' },
    },
  ],
  else: { type: 'static', value: 'LAST RESORT' },
}

eq('branch 0 wins when primary matches', selectBranchValue(priceRules, '100 DKK', resolve), '100 DKK')

product.price = '100' // no longer on sale -> fall through to the rules
eq('first matching else-if wins', selectBranchValue(priceRules, '100 DKK', resolve), '25 DKK')

product.unit_price = '' // rule 1 no longer matches -> rule 2
eq('second else-if when first misses', selectBranchValue(priceRules, '100 DKK', resolve), 'VINO FALLBACK')

product.vendor = 'Other'
eq('else when no rule matches', selectBranchValue(priceRules, '100 DKK', resolve), 'LAST RESORT')

// Reordering changes the winner — the list IS the priority.
const swapped: OnlyIf = { ...priceRules, rules: [priceRules.rules![1], priceRules.rules![0]] }
product.vendor = 'Vino'
product.unit_price = '25'
eq('reordering flips the winner', selectBranchValue(swapped, '100 DKK', resolve), 'VINO FALLBACK')

// A half-filled rule (no field yet) must not swallow everything.
const halfFilled: OnlyIf = {
  conditions: [{ field: 'price', operator: 'less_than_field', value: 'compare_at_price', logic: null }],
  rules: [{
    conditions: [{ field: '', operator: 'equals', value: '', logic: null }],
    value: { type: 'static', value: 'GHOST' },
  }],
  else: { type: 'static', value: 'LAST RESORT' },
}
eq('incomplete rule is skipped', selectBranchValue(halfFilled, 'BASE', resolve), 'LAST RESORT')

// Legacy config with no `rules` key behaves exactly as before.
const legacy: OnlyIf = {
  conditions: [{ field: 'price', operator: 'less_than_field', value: 'compare_at_price', logic: null }],
  else: { type: 'static', value: 'out_of_stock' },
}
eq('legacy config unchanged', selectBranchValue(legacy, 'BASE', resolve), 'out_of_stock')
eq('no conditions = base value', selectBranchValue(undefined, 'BASE', resolve), 'BASE')

// ── extract with pattern ───────────────────────────────────────────────────
const sizePatterns: ExtractPattern[] = [
  { pattern: '-(\\d{2})(\\d{2})-tall-', template: '$1/$2 Tall', ignoreCase: true },
  { pattern: '-(\\d{2})(\\d{2})-[a-z]+$', template: '$1/$2', ignoreCase: true },
  { pattern: '-(xs|s|ml|m|l|xl)-[a-z]+$', template: '$1', ignoreCase: true },
]
const sizeLookup = [{ from: 'ml', to: 'M/L' }, { from: 'groen', to: 'Grøn' }]
const ex = (s: string) => extractWithPatterns(s, sizePatterns, sizeLookup)

eq('extract: 3637 -> 36/37', ex('https://shop.dk/products/fuga-v3-3637-sort'), { value: '36/37', patternIndex: 1 })
eq('extract: first matching pattern wins', ex('/products/fuga-v3-3637-tall-sort'), { value: '36/37 Tall', patternIndex: 0 })
eq('extract: lookup rewrites a group', ex('/products/top-ml-sort'), { value: 'M/L', patternIndex: 2 })
eq('extract: lookup is case-insensitive', ex('/products/top-ML-sort'), { value: 'M/L', patternIndex: 2 })
eq('extract: unmapped group passes through', ex('/products/top-xl-sort'), { value: 'xl', patternIndex: 2 })
eq('extract: no match is empty', ex('/products/gift-card'), { value: '', patternIndex: -1 })
eq('extract: empty input is empty', ex(''), { value: '', patternIndex: -1 })
eq(
  'extract: colour via lookup',
  extractWithPatterns('fuga-v3-3637-groen', [{ pattern: '-([a-z]+)$', template: '$1' }], sizeLookup),
  { value: 'Grøn', patternIndex: 0 }
)
eq(
  'extract: named groups, $& and $$',
  extractWithPatterns('size-42', [{ pattern: '(?<n>\\d+)', template: '$<n> ($&) $$' }]),
  { value: '42 (42) $', patternIndex: 0 }
)
eq(
  'extract: optional group that did not match is empty',
  extractWithPatterns('36', [{ pattern: '(\\d+)(x)?', template: '$1$2' }]),
  { value: '36', patternIndex: 0 }
)
eq(
  'extract: $n beyond the group count stays visible',
  extractWithPatterns('36', [{ pattern: '(\\d+)', template: '$1 $3' }]),
  { value: '36 $3', patternIndex: 0 }
)
eq(
  'extract: invalid pattern is skipped, next one used',
  extractWithPatterns('abc', [{ pattern: '([a-', template: 'X' }, { pattern: 'b', template: 'B' }]),
  { value: 'B', patternIndex: 1 }
)
eq(
  'extract: nested repetition is refused, not run',
  extractWithPatterns('a'.repeat(40) + '!', [{ pattern: '(a+)+$', template: 'BAD' }]),
  { value: '', patternIndex: -1 }
)
eq('extract: case-sensitive by default', extractWithPatterns('SORT', [{ pattern: 'sort', template: 'x' }]).patternIndex, -1)
eq('patternError: ok pattern', patternError('-(\\d{2})(\\d{2})-'), null)
eq('patternError: bounded repeat of a group is allowed', patternError('(\\d{2}){2}'), null)
eq('patternError: nested quantifier flagged', typeof patternError('(\\w*)*'), 'string')
eq('patternError: syntax error flagged', typeof patternError('(abc'), 'string')
eq('patternError: 1,500 chars is allowed', patternError('a'.repeat(1500)), null)
eq('patternError: too long flagged', typeof patternError('a'.repeat(2001)), 'string')
{
  // A long alternation — the real-world reason for the higher limit.
  const colours = Array.from({ length: 60 }, (_, i) => `farve${i}`).join('|')
  const long = `-(${colours})$`
  eq('extract: pattern over 300 chars still runs', long.length > 300 && extractWithPatterns('x-farve42', [{ pattern: long, template: '$1' }]).value, 'farve42')
}
eq(
  'patternProblems: reports refused rows by index, skips empty ones',
  patternProblems([
    { pattern: '', template: '' },
    { pattern: '(a+)+', template: '' },
    { pattern: 'ok', template: '' },
    { pattern: 'a'.repeat(2001), template: '' },
  ]).map((p) => p.index),
  [1, 3]
)
eq(
  'extract + only-if: else branch still applies',
  selectBranchValue(
    {
      conditions: [{ field: 'vendor', operator: 'equals', value: 'Fuga', logic: null }],
      else: { type: 'static', value: 'One size' },
    },
    ex('/products/fuga-v3-3637-sort').value,
    (f) => ({ vendor: 'Other' } as Record<string, string>)[f] ?? ''
  ),
  'One size'
)

// ── combine: skip empty fields ─────────────────────────────────────────────
{
  const vals: Record<string, string> = { title: 'BARE Sports 7mm Reactive Full V3. Mens', color: 'Sort', size: 'L' }
  const r = (f: string) => vals[f] ?? ''
  const blocks: CombineBlock[] = [
    { type: 'field', value: 'title' },
    { type: 'text', value: ' – ' },
    { type: 'field', value: 'color' },
    { type: 'text', value: ' – ' },
    { type: 'field', value: 'size' },
  ]
  eq('combine skip: both filled', combineBlocks(blocks, r, true), 'BARE Sports 7mm Reactive Full V3. Mens – Sort – L')
  vals.color = ''
  eq('combine skip: only size', combineBlocks(blocks, r, true), 'BARE Sports 7mm Reactive Full V3. Mens – L')
  vals.color = 'Sort'; vals.size = ''
  eq('combine skip: only colour', combineBlocks(blocks, r, true), 'BARE Sports 7mm Reactive Full V3. Mens – Sort')
  vals.color = ''
  eq('combine skip: neither', combineBlocks(blocks, r, true), 'BARE Sports 7mm Reactive Full V3. Mens')
  eq('combine legacy: unchanged concatenation', combineBlocks(blocks, r, false), 'BARE Sports 7mm Reactive Full V3. Mens –  – ')
  vals.size = 'L'
  eq(
    'combine skip: no leading separator when the first field is empty',
    combineBlocks([{ type: 'field', value: 'color' }, { type: 'text', value: ' – ' }, { type: 'field', value: 'size' }], r, true),
    'L'
  )
  eq(
    'combine skip: a real prefix is kept',
    combineBlocks([{ type: 'text', value: 'Size: ' }, { type: 'field', value: 'size' }], r, true),
    'Size: L'
  )
  eq(
    'combine skip: prefix and suffix vanish with an empty field',
    combineBlocks([{ type: 'text', value: 'Colour: ' }, { type: 'field', value: 'color' }, { type: 'text', value: '!' }], r, true),
    ''
  )
  eq(
    'combine skip: double spaces collapse',
    combineBlocks([{ type: 'text', value: 'a  ' }, { type: 'text', value: ' b' }], r, true),
    'a b'
  )
}

// ── whole-word matching ────────────────────────────────────────────────────
eq('word: "L" is not inside "Full"', containsWord('Reactive Full V3. Mens', 'L', true), false)
eq('word: "L" as its own word', containsWord('Reactive Full V3. Mens L', 'L', true), true)
eq('word: ignores case', containsWord('Wetsuit SORT', 'sort', true), true)
eq('word: case-sensitive when asked', containsWord('Wetsuit SORT', 'sort', false), false)
eq('word: "Sort" not inside "Sortiment"', containsWord('Sortiment', 'Sort', true), false)
eq('word: Nordic letters are letters', containsWord('Grønne', 'Grøn', true), false)
eq('word: 36/37 with punctuation around', containsWord('Fuga (36/37)', '36/37', true), true)
eq('word: phrase', containsWord('Jakke Dark Blue L', 'dark blue', true), true)
eq('word: empty needle never matches', containsWord('anything', '', true), false)

// ── conditions: field comparison + case ───────────────────────────────────
{
  const vals: Record<string, string> = { title: 'Neopren Blue L', 'feed:color': 'blue', 'feed:size': 'L' }
  const r = (f: string) => vals[f] ?? ''
  const cond = (operator: string, value: string, caseSensitive?: boolean) =>
    evalCondition({ field: 'title', operator, value, logic: null, caseSensitive }, r)
  eq('cond: contains_field ignoring case', cond('contains_field', 'feed:color', false), true)
  eq('cond: contains_field case-sensitive (legacy default)', cond('contains_field', 'feed:color'), false)
  eq('cond: not_contains_word_field', cond('not_contains_word_field', 'feed:size', false), false)
  vals.title = 'Reactive Full V3. Mens'
  eq('cond: not_contains_word_field ignores "L" in "Full"', cond('not_contains_word_field', 'feed:size', false), true)
  eq('cond: legacy equals still case-sensitive', cond('equals', 'reactive full v3. mens'), false)
  eq('cond: equals ignoring case', cond('equals', 'reactive full v3. mens', false), true)
  eq('cond: starts_with_field', evalCondition({ field: 'a', operator: 'starts_with_field', value: 'b', logic: null }, (f) => (f === 'a' ? 'abc' : 'ab')), true)
}

// ── item evaluator: feed fields, the title use case, AI title ─────────────
{
  const source: Record<string, string> = {
    title: 'BARE Sports 7mm Reactive Full V3. Mens',
    handle: 'bare-7mm-reactive-full-v3-mens-sort-l',
  }
  const mappings: EvalMapping[] = [
    {
      google_field: 'color',
      mapping_type: 'EXTRACT',
      config: { field: 'handle', patterns: [{ pattern: '-(sort|blaa|blue)-[a-z]+$', template: '$1', ignoreCase: true }], lookup: [{ from: 'sort', to: 'Sort' }] },
    },
    {
      google_field: 'size',
      mapping_type: 'EXTRACT',
      config: { field: 'handle', patterns: [{ pattern: '-(xs|s|m|l|xl)$', template: '$1', ignoreCase: true }], lookup: [{ from: 'l', to: 'L' }] },
    },
    {
      google_field: 'title',
      mapping_type: 'COMBINE',
      config: {
        skipEmpty: true,
        blocks: [
          { type: 'field', value: 'title' },
          { type: 'text', value: ' – ' },
          { type: 'field', value: 'feed:color', skipIfPresent: true },
          { type: 'text', value: ' – ' },
          { type: 'field', value: 'feed:size', skipIfPresent: true },
        ],
      },
    },
  ]
  const ev = (aiTitle: string | null = null, ms = mappings) =>
    createItemEvaluator({ mappings: ms, resolveSource: (f) => source[f] ?? '', aiTitle })
  eq('eval: title built from mapped colour + size', ev().value('title'), 'BARE Sports 7mm Reactive Full V3. Mens – Sort – L')
  eq('eval: feed:color reads the final colour', ev().resolve('feed:color'), 'Sort')
  source.title = 'BARE Sports 7mm Reactive Full V3. Mens Sort'
  eq('eval: colour already in title is skipped (with its separator)', ev().value('title'), 'BARE Sports 7mm Reactive Full V3. Mens Sort – L')
  source.title = 'BARE Sports 7mm Reactive Full V3. Mens'
  source.handle = 'gavekort'
  eq('eval: no colour, no size → plain title', ev().value('title'), 'BARE Sports 7mm Reactive Full V3. Mens')
  source.handle = 'bare-7mm-reactive-full-v3-mens-sort-l'
  eq('eval: AI title is built on by a skip-empty Combine', ev('Optimised Wetsuit').value('title'), 'Optimised Wetsuit – Sort – L')
  const plainTitle: EvalMapping[] = [...mappings.slice(0, 2), { google_field: 'title', mapping_type: 'FIELD', config: { field: 'title' } }]
  eq('eval: AI title still replaces other title mappings', ev('Optimised Wetsuit', plainTitle).value('title'), 'Optimised Wetsuit')
  const cyclic: EvalMapping[] = [
    { google_field: 'a', mapping_type: 'COMBINE', config: { blocks: [{ type: 'text', value: 'A' }, { type: 'field', value: 'feed:b' }] } },
    { google_field: 'b', mapping_type: 'COMBINE', config: { blocks: [{ type: 'text', value: 'B' }, { type: 'field', value: 'feed:a' }] } },
  ]
  {
    const e = ev(null, cyclic)
    eq('eval: a reference cycle is cut, not infinite', [e.value('a'), e.value('b')], ['AB', 'BA'])
    const e2 = ev(null, cyclic)
    eq('eval: cycle result does not depend on evaluation order', [e2.value('b'), e2.value('a')], ['BA', 'AB'])
  }
  const withAi: EvalMapping[] = [{ google_field: 'x', mapping_type: 'AI', config: { prompt: 'p' } }]
  eq('eval: an AI mapping reads as empty via feed:', ev(null, withAi).resolve('feed:x'), '')
  eq('eval: AI mapping value() is null for the caller to resolve', ev(null, withAi).value('x'), null)
  eq(
    'eval: only-if can read a mapped field',
    createItemEvaluator({
      mappings: [
        mappings[1],
        {
          google_field: 'size_system',
          mapping_type: 'STATIC',
          config: {
            value: 'EU',
            onlyIf: { conditions: [{ field: 'feed:size', operator: 'is_not_empty', value: '', logic: null }], else: { type: 'empty', value: '' } },
          },
        },
      ],
      resolveSource: (f) => source[f] ?? '',
    }).value('size_system'),
    'EU'
  )
}

console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} check(s) FAILED.`)
process.exit(fails === 0 ? 0 : 1)
