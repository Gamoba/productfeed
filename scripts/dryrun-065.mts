// Dry run of migration 065: twice in a transaction, checks, rolls back.
//   npx tsx scripts/dryrun-065.mts
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
const body = readFileSync(join(process.cwd(), 'supabase/migrations/065_custom_plan_links.sql'), 'utf-8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')
const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1, onnotice: () => {} })
class Rollback extends Error {}
let fails = 0
const check = (n: string, ok: boolean) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}`); if (!ok) fails++ }
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(body)
    await tx.unsafe(body)
    await tx`INSERT INTO plans (id, name, is_custom, account_id) VALUES ('custom-dryrun', 'Dry run', true, NULL)`
    check('custom plan without an account allowed', true)
    await tx.unsafe('SAVEPOINT s')
    let refused = false
    try {
      const [a] = await tx`SELECT id FROM accounts LIMIT 1`
      await tx`INSERT INTO plans (id, name, is_custom, account_id) VALUES ('public-dryrun', 'X', false, ${a.id})`
    } catch { refused = true; await tx.unsafe('ROLLBACK TO SAVEPOINT s') }
    check('public plan with an account refused', refused)
    const [t] = await tx`SELECT relrowsecurity r FROM pg_class WHERE relname = 'plan_signup_links'`
    check('plan_signup_links has RLS', t?.r === true)
    throw new Rollback()
  })
} catch (e) {
  if (!(e instanceof Rollback)) { console.error('DRY RUN FAILED:', e); fails++ } else console.log('Rolled back.')
} finally { await sql.end() }
console.log(fails ? `${fails} FAILED` : 'PASS')
