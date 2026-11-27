// Dry run of migration 068: applies it in a transaction, checks the columns
// and that existing referrals are untouched, and rolls back.
//   npx tsx scripts/dryrun-068.mts
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
const body = readFileSync(join(process.cwd(), 'supabase/migrations/068_referral_review.sql'), 'utf-8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')
const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1, onnotice: () => {} })
class Rollback extends Error {}
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${extra ? ` — ${extra}` : ''}`)
  if (!ok) fails++
}

try {
  await sql.begin(async (tx) => {
    const [{ n: before }] = await tx`SELECT count(*)::int AS n FROM referrals`
    await tx.unsafe(body)
    await tx.unsafe(body) // idempotent: replaying changes nothing
    const cols = await tx`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'referrals' AND column_name IN ('needs_review', 'review_reason') ORDER BY column_name`
    check('both columns exist', cols.length === 2, cols.map((c) => `${c.column_name} ${c.data_type}`).join(', '))
    const [{ n: after, flagged }] = await tx`SELECT count(*)::int AS n, count(*) FILTER (WHERE needs_review)::int AS flagged FROM referrals`
    check('no referral added or removed', before === after, `${after} referrals`)
    check('no existing referral flagged', flagged === 0)
    throw new Rollback()
  })
} catch (e) {
  if (!(e instanceof Rollback)) { console.error('DRY RUN FAILED:', e); fails++ } else console.log('Rolled back.')
} finally { await sql.end() }
console.log(fails ? `${fails} FAILED` : 'PASS')
