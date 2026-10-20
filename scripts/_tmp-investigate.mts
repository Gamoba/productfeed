import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
const { createClient } = await import('@supabase/supabase-js')
const { getStockForFeed } = await import('../lib/inventoryAnalytics')
const { getProductPerformance } = await import('../lib/googleAdsAnalytics')

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const { data: feeds } = await db.from('google_ads_feed_settings').select('feed_id').not('customer_id', 'is', null)

for (const f of feeds ?? []) {
  const stock = await getStockForFeed(db, f.feed_id)
  const { rows } = await getProductPerformance(db, f.feed_id, 30, { roas: [], poas: [] })
  console.log(`\n=== feed ${f.feed_id.slice(0,8)} ===`)

  let mismatches = 0
  const examples: string[] = []
  for (const r of rows) {
    if (!r.productRef) continue
    const s = stock.byProduct.get(r.productRef)
    if (!s) continue
    if (r.variantCount !== s.variantsTotal) {
      mismatches++
      if (examples.length < 6) {
        const gone = s.variantsTotal - s.variantsSellable
        examples.push(
          `  ${r.productRef} "${(r.title ?? '').slice(0,34)}"\n` +
          `      renders as: "${r.variantCount} variant${r.variantCount===1?'':'s'}` +
          (gone > 0 && s.variantsSellable > 0 ? ` · ${gone} of ${s.variantsTotal} out of stock"` : '"') +
          `\n      ads item_ids: ${r.variantCount} · catalogue variants: ${s.variantsTotal} · sellable: ${s.variantsSellable}`
        )
      }
    }
  }
  console.log(`rows with ads-vs-catalogue variant count mismatch: ${mismatches} of ${rows.length}`)
  examples.forEach((e) => console.log(e))

  // Is the catalogue itself ever holding duplicate variant ids?
  const { data: prods } = await db.from('products').select('shopify_id, variants').eq('feed_id', f.feed_id).eq('status','active')
  let dupes = 0
  for (const p of prods ?? []) {
    const vs = Array.isArray(p.variants) ? p.variants : []
    const ids = vs.map((v: any) => String(v?.id))
    if (new Set(ids).size !== ids.length) { dupes++; console.log(`  DUPLICATE variant ids in product ${p.shopify_id}: ${ids.join(',')}`) }
  }
  console.log(`products with duplicate variant ids in the jsonb: ${dupes}`)
}
