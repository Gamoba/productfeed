// Dry run of migration 063: runs it twice inside one transaction, then acts
// as the public roles (anon, authenticated) and as the service role to check
// who can read and write what, then ROLLS BACK. Nothing is kept.
//
//   npx tsx scripts/dryrun-063.mts
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}

const body = readFileSync(join(process.cwd(), 'supabase/migrations/063_lock_public_api.sql'), 'utf-8')
  .replace(/^\s*BEGIN;\s*$/m, '')
  .replace(/^\s*COMMIT;\s*$/m, '')

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1, onnotice: () => {} })
class Rollback extends Error {}
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

try {
  await sql.begin(async (tx) => {
    const [{ n: feedsBefore }] = await tx`SELECT count(*)::int n FROM feeds`
    await tx.unsafe(body)
    await tx.unsafe(body)

    const [{ n: open }] = await tx`
      SELECT count(*)::int n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity`
    check('every public table has RLS', open === 0, `${open} without`)

    const [proj] = await tx`SELECT id FROM projects LIMIT 1`
    for (const role of ['anon', 'authenticated']) {
      await tx.unsafe(`SAVEPOINT s; SET LOCAL ROLE ${role}`)
      const [{ n }] = await tx`SELECT count(*)::int n FROM feeds`
      check(`${role}: reads no feeds`, n === 0, `${n} rows`)
      const [{ n: c }] = await tx`SELECT count(*)::int n FROM google_ads_connections`
      check(`${role}: reads no Google Ads connections`, c === 0, `${c} rows`)
      let wrote = true
      try {
        await tx`INSERT INTO feeds (name, project_id) VALUES ('rls-dryrun', ${proj.id})`
      } catch {
        wrote = false
      }
      check(`${role}: can't insert a feed`, !wrote)
      await tx.unsafe('ROLLBACK TO SAVEPOINT s; SAVEPOINT s; SET LOCAL ROLE ' + role)
      let called = true
      try {
        await tx`SELECT increment_rate_limit('00000000-0000-0000-0000-000000000000'::uuid, 'x', now(), 1, 1)`
      } catch {
        called = false
      }
      check(`${role}: can't call increment_rate_limit`, !called)
      await tx.unsafe('ROLLBACK TO SAVEPOINT s')
      await tx.unsafe('RESET ROLE')
    }

    await tx.unsafe('SAVEPOINT s; SET LOCAL ROLE service_role')
    const [{ n: svc }] = await tx`SELECT count(*)::int n FROM feeds`
    check('service_role: still reads every feed', svc === feedsBefore, `${svc} of ${feedsBefore}`)
    let svcCall = true
    try {
      await tx`SELECT increment_rate_limit('00000000-0000-0000-0000-000000000000'::uuid, 'dryrun', now(), 1, 1)`
    } catch {
      svcCall = false
    }
    check('service_role: can call app functions', svcCall)
    await tx.unsafe('ROLLBACK TO SAVEPOINT s')
    await tx.unsafe('RESET ROLE')

    const pols = await tx`SELECT tablename, cmd FROM pg_policies WHERE schemaname='public' AND tablename IN ('projects','shop_settings')`
    check('projects and shop_settings policies are read-only', pols.every((p) => p.cmd === 'SELECT'), pols.map((p) => `${p.tablename}:${p.cmd}`).join(', '))

    throw new Rollback()
  })
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error('DRY RUN FAILED:', e)
    failures++
  } else {
    console.log('Rolled back. Nothing was kept.')
  }
} finally {
  await sql.end()
}
console.log(failures ? `${failures} FAILED` : 'PASS')
process.exitCode = failures ? 1 : 0
