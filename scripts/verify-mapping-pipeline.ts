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
import { selectBranchValue, type OnlyIf } from '../lib/mappingRules'

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

console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} check(s) FAILED.`)
process.exit(fails === 0 ? 0 : 1)
