// Dry run of migration 064: runs it twice in a transaction, checks, rolls back.
//   npx tsx scripts/dryrun-064.mts
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
const body = readFileSync(join(process.cwd(), 'supabase/migrations/064_mcc_invite_name.sql'), 'utf-8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')
const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1, onnotice: () => {} })
class Rollback extends Error {}
try {
  await sql.begin(async (tx) => {
    await tx.unsafe(body)
    await tx.unsafe(body)
    const [c] = await tx`SELECT count(*)::int n FROM information_schema.columns WHERE table_name = 'mcc_signup_invites' AND column_name = 'name'`
    const [i] = await tx`SELECT count(*)::int n FROM pg_indexes WHERE indexname = 'idx_access_grants_user'`
    console.log(c.n === 1 && i.n === 1 ? 'PASS: column and index in place, replay OK' : 'FAIL')
    throw new Rollback()
  })
} catch (e) {
  if (!(e instanceof Rollback)) { console.error('DRY RUN FAILED:', e); process.exitCode = 1 } else console.log('Rolled back.')
} finally { await sql.end() }
