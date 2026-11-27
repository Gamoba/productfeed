// Extra-SKU billing, end to end against the real database (migration 066).
//
// Four things it can do:
//
//   npx tsx --tsconfig tsconfig.json scripts/test-skus.ts count <projectId>
//       Counts one shop's SKUs now and stores today's row. Prints what each
//       feed contributes, so you can check the figure against the shop.
//
//   npx tsx --tsconfig tsconfig.json scripts/test-skus.ts measure
//       Runs the daily job for every shop that hasn't been counted today,
//       the same as /api/cron/sku-usage.
//
//   npx tsx --tsconfig tsconfig.json scripts/test-skus.ts show <accountId>
//       What the account has used this month and last, and what was billed.
//
//   npx tsx --tsconfig tsconfig.json scripts/test-skus.ts charge <accountId> [YYYY-MM] [--live]
//       Bills the account for a finished month. Without --live it's a dry run
//       and nothing is sent to Stripe. With --live it really bills: a pending
//       invoice item on a monthly plan, a separate invoice on a yearly one.
//
//   npx tsx --tsconfig tsconfig.json scripts/test-skus.ts fake <accountId> <projectId> <skus> [YYYY-MM-DD]
//       Writes a usage row by hand, to try the billing without waiting for a
//       big catalogue. Use `undo` with the same date to remove it again.
//
// Test keys only for `charge --live`, so a real customer is never billed by a
// test run.
import { readFileSync } from 'fs'

for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}

const [, , cmd, ...args] = process.argv
const live = args.includes('--live')
const rest = args.filter((a) => a !== '--live')

const euro = (cents: number, currency = 'eur') =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)

async function main() {
  const { adminDb } = await import('../lib/feeds')
  const { countShopSkus, measureDueShops, measureShop } = await import('../lib/skuMeasure')
  const { accountDailyTotals, accountMonthPeak, monthStart, previousMonthStart, today } = await import('../lib/skuUsage')
  const { chargeExtraSkusFor, extraSkuBasis, recentSkuCharges } = await import('../lib/extraSkus')
  const { includedProducts } = await import('../lib/feedGenerator')
  const db = adminDb()

  if (cmd === 'count') {
    const projectId = rest[0]
    if (!projectId) throw new Error('Which shop? Pass a project id.')
    const { data: shop } = await db.from('projects').select('id, name, account_id').eq('id', projectId).maybeSingle()
    if (!shop) throw new Error('No such shop.')
    const { data: feeds } = await db.from('feeds').select('id, name').eq('project_id', projectId)
    for (const f of (feeds ?? []) as { id: string; name: string }[]) {
      const { data: s } = await db.from('feed_settings').select('feed_mode').eq('feed_id', f.id).maybeSingle()
      const mode = (s as { feed_mode?: string } | null)?.feed_mode === 'variant' ? 'per variant' : 'per product'
      const inc = await includedProducts(f.id)
      console.log(
        `  feed ${f.name} (${mode}): ${inc.included} of ${inc.total} products included` +
          (inc.includedShopifyIds === null ? ' (no filtering rule)' : '')
      )
    }
    const count = await countShopSkus(db, projectId)
    console.log(`${(shop as { name: string }).name}: ${count.skus} SKUs over ${count.products} products in ${count.feeds} feeds`)
    await measureShop(db, shop as { id: string; account_id: string })
    console.log(`Stored for ${today()}.`)
    return
  }

  if (cmd === 'measure') {
    const r = await measureDueShops(db, { budgetMs: 10 * 60 * 1000 })
    for (const m of r.measured) console.log(`  ${m.projectId}: ${m.skus} SKUs (${m.products} products)`)
    for (const f of r.failed) console.log(`  FAILED ${f.projectId}: ${f.error}`)
    console.log(`Measured ${r.measured.length}, failed ${r.failed.length}, left ${r.remaining}.`)
    return
  }

  if (cmd === 'show') {
    const accountId = rest[0]
    if (!accountId) throw new Error('Which account? Pass an account id.')
    for (const month of [monthStart(new Date()), previousMonthStart(new Date())]) {
      const days = await accountDailyTotals(db, accountId, month)
      const { peak } = await accountMonthPeak(db, accountId, month)
      console.log(`${month}: ${days.length} days measured, highest ${peak} SKUs`)
      for (const d of days) console.log(`    ${d.on}  ${d.skus}`)
      const basis = await extraSkuBasis(db, accountId, month)
      if (basis) {
        console.log(
          `    plan ${basis.planName} (${basis.interval}), ${basis.includedSkus ?? '—'} included, ` +
            `${basis.extraThousands} × 1,000 extra = ${euro(basis.amountCents, basis.currency)}`
        )
      }
    }
    const charges = await recentSkuCharges(db, accountId)
    for (const c of charges) {
      console.log(`  billed ${c.month}: ${c.status}, peak ${c.peakSkus}, ${euro(c.amountCents, c.currency)}`)
    }
    return
  }

  if (cmd === 'charge') {
    const accountId = rest[0]
    if (!accountId) throw new Error('Which account? Pass an account id.')
    const month = rest[1] ? `${rest[1]}-01` : previousMonthStart(new Date())
    if (live && !(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_')) {
      throw new Error('Test keys only for --live.')
    }
    const r = await chargeExtraSkusFor(db, accountId, month, { dryRun: !live })
    console.log(
      `${month}: ${r.status}, peak ${r.peakSkus}, included ${r.includedSkus ?? '—'}, ${euro(r.amountCents, r.currency)}` +
        (r.note ? ` — ${r.note}` : '') +
        (r.stripeInvoiceId ? ` — invoice ${r.stripeInvoiceId}` : '')
    )
    return
  }

  if (cmd === 'fake' || cmd === 'undo') {
    const [accountId, projectId, skus, on] = rest
    const day = on ?? today()
    if (cmd === 'undo') {
      if (!projectId) throw new Error('Pass the project id and the date to remove.')
      await db.from('shop_sku_usage').delete().eq('project_id', projectId).eq('measured_on', day)
      console.log(`Removed the row for ${projectId} on ${day}.`)
      return
    }
    if (!accountId || !projectId || !skus) throw new Error('Pass an account id, a project id and a SKU count.')
    const n = Number(skus)
    const { error } = await db.from('shop_sku_usage').upsert(
      {
        project_id: projectId,
        measured_on: day,
        account_id: accountId,
        sku_count: n,
        product_count: n,
        feed_count: 1,
        measured_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,measured_on' }
    )
    if (error) throw new Error(error.message)
    console.log(`Wrote ${n} SKUs for ${projectId} on ${day}. Remove it again with: undo x ${projectId} x ${day}`)
    return
  }

  console.log(readFileSync('scripts/test-skus.ts', 'utf-8').split('\n').slice(0, 27).join('\n'))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
