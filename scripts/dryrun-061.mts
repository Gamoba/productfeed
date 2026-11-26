// Dry run of migration 061: runs it twice (to prove it replays) inside one
// transaction, checks the result, then ROLLS BACK. Nothing is kept.
//
//   npx tsx scripts/dryrun-061.mts
import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'

for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}

const body = readFileSync(join(process.cwd(), 'supabase/migrations/061_billing_accounts.sql'), 'utf-8')
  .replace(/^\s*BEGIN;\s*$/m, '')
  .replace(/^\s*COMMIT;\s*$/m, '')

const sql = postgres(process.env.DATABASE_URL!, { ssl: 'require', max: 1 })

class Rollback extends Error {}

try {
  await sql.begin(async (tx) => {
    const before = await tx`SELECT count(*)::int AS n FROM accounts`
    await tx.unsafe(body)
    await tx.unsafe(body) // replay: must be a no-op

    const checks = {
      accounts: before[0].n,
      exempt: (await tx`SELECT count(*)::int AS n FROM accounts WHERE billing_exempt`)[0].n,
      nonUser: (await tx`SELECT count(*)::int AS n FROM accounts WHERE type <> 'user'`)[0].n,
      plans: (await tx`SELECT id, self_serve, feed_limit, shop_limit FROM plans ORDER BY sort_order`),
      prices: (await tx`SELECT count(*)::int AS n FROM plan_prices`)[0].n,
      tables: (await tx`
        SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'public' AND rowsecurity AND tablename = ANY(${[
          'platform_admins', 'platform_settings', 'plans', 'plan_prices', 'stripe_customers',
          'subscriptions', 'stripe_events', 'mcc_signup_invites', 'referral_links',
          'access_grants', 'referrals', 'commission_payouts', 'commissions',
        ]})`)[0].n,
    }
    console.log(JSON.stringify(checks, null, 2))

    // A new account after the migration must NOT be exempt.
    const [fresh] = await tx`INSERT INTO accounts (name) VALUES ('dryrun') RETURNING billing_exempt, type`
    console.log('new account:', fresh)

    // Constraints: a feed-scope grant without a feed must fail.
    const [a] = await tx`SELECT id FROM accounts WHERE name <> 'dryrun' LIMIT 1`
    const [b] = await tx`INSERT INTO accounts (name, type) VALUES ('dryrun-mcc', 'mcc') RETURNING id`
    await tx`SAVEPOINT s`
    try {
      await tx`INSERT INTO access_grants (user_account_id, mcc_account_id, scope, source) VALUES (${a.id}, ${b.id}, 'feed', 'access_code')`
      console.log('feed-scope check: NOT enforced (bad)')
    } catch {
      console.log('feed-scope check: enforced')
      await tx`ROLLBACK TO SAVEPOINT s`
    }

    throw new Rollback()
  })
} catch (e) {
  if (!(e instanceof Rollback)) {
    console.error('DRY RUN FAILED:', e)
    process.exitCode = 1
  } else {
    console.log('Rolled back. Nothing was kept.')
  }
} finally {
  await sql.end()
}
