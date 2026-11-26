// Checks plan standing and limits (lib/entitlements.ts, lib/ops/limits.ts)
// against the real database, on a temporary account that is deleted at the
// end, whatever happens. No Stripe calls: the subscription rows are fakes.
//
//   npx tsx --tsconfig tsconfig.json scripts/test-limits.ts
import { readFileSync } from 'fs'

for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
  const [k, ...rest] = line.split('=')
  if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
}
if (!(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_')) {
  console.error('Test keys only (the fake rows are test mode).')
  process.exit(1)
}

async function main() {
  const { adminDb } = await import('../lib/feeds')
  const E = await import('../lib/entitlements')
  const L = await import('../lib/ops/limits')
  const db = adminDb()
  let failures = 0
  const check = (name: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`)
    if (!ok) failures++
  }
  const refused = async (p: Promise<unknown>) => {
    try {
      await p
      return null
    } catch (e) {
      return e instanceof L.LimitError ? e.message : `other error: ${(e as Error).message}`
    }
  }

  const tag = `limits-test-${Date.now()}`
  const { data: acc, error } = await db.from('accounts').insert({ name: tag, type: 'user' }).select('id').single()
  if (error || !acc) throw error
  const accountId = acc.id as string
  const { data: mcc } = await db.from('accounts').insert({ name: `${tag}-mcc`, type: 'mcc' }).select('id').single()
  const mccId = mcc!.id as string
  const sub = async (status: string) => {
    await db.from('subscriptions').delete().eq('account_id', accountId)
    if (status === 'none') return
    await db.from('subscriptions').insert({
      account_id: accountId, plan_id: 'standard', kind: 'plan', interval: 'month', status,
      stripe_subscription_id: `sub_${tag}`, livemode: false,
    })
  }

  try {
    // New account, never paid.
    let e = (await E.getEntitlements(db, accountId))!
    check('new account: standing new, locked', e.standing === 'new' && e.locked, e.standing)
    check('new account: blocks the app', E.blocksApp(e))
    check('new account: shop creation refused', !!(await refused(L.assertCanCreateShop(db, accountId))))

    await sub('incomplete')
    e = (await E.getEntitlements(db, accountId))!
    check('only an incomplete checkout: still new', e.standing === 'new', e.standing)

    // Active Standard: 1 shop, 3 feeds, 1 user, daily syncs.
    await sub('active')
    e = (await E.getEntitlements(db, accountId))!
    check('active: standing active, Standard limits', e.standing === 'active' && !e.locked && e.plan?.id === 'standard')
    check('active: first shop allowed', (await refused(L.assertCanCreateShop(db, accountId))) === null)
    const { data: proj } = await db.from('projects').insert({ name: `${tag}-shop`, account_id: accountId }).select('id').single()
    const projectId = proj!.id as string
    const msg = await refused(L.assertCanCreateShop(db, accountId))
    check('active: second shop refused', !!msg, msg ?? '')
    for (let i = 0; i < 3; i++) {
      check(`active: feed ${i + 1} allowed`, (await refused(L.assertCanCreateFeed(db, accountId))) === null)
      const { error: fErr } = await db.from('feeds').insert({ name: `${tag}-feed-${i}`, project_id: projectId })
      if (fErr) throw fErr
    }
    const fmsg = await refused(L.assertCanCreateFeed(db, accountId))
    check('active: fourth feed refused', !!fmsg, fmsg ?? '')
    const umsg = await refused(L.assertCanAddMember(db, accountId, 1))
    check('active: second user refused', !!umsg, umsg ?? '')
    check('active: daily sync allowed', (await refused(L.assertFrequencyAllowed(db, accountId, 'daily'))) === null)
    check('active: every 12 h refused', !!(await refused(L.assertFrequencyAllowed(db, accountId, '12h'))))
    check('active: hourly capped to daily in the cron', E.capFrequency(e, 'hourly') === 'daily', E.capFrequency(e, 'hourly'))

    const { data: feed } = await db.from('feeds').select('id').eq('project_id', projectId).limit(1).single()
    check('active: feed is served', !(await E.feedServingBlocked(db, feed!.id)))

    // Payment failed, Stripe retrying.
    await sub('past_due')
    e = (await E.getEntitlements(db, accountId))!
    check('past_due: grace, not locked', e.standing === 'grace' && !e.locked, e.standing)
    check('past_due: feed still served', !(await E.feedServingBlocked(db, feed!.id)))

    // Plan ended.
    await sub('canceled')
    e = (await E.getEntitlements(db, accountId))!
    check('canceled: lapsed and locked', e.standing === 'lapsed' && e.locked, e.standing)
    check('canceled: feed not served', await E.feedServingBlocked(db, feed!.id))
    check('canceled: in lockedAccountIds', (await E.lockedAccountIds(db, [accountId])).has(accountId))

    // MCC without a plan: free as an account, but owns no shops.
    const m = (await E.getEntitlements(db, mccId))!
    check('MCC without plan: does not block the app', !E.blocksApp(m))
    check('MCC without plan: its shops are locked', E.shopsLocked(m))
    check('MCC without plan: unlimited users', (await refused(L.assertCanAddMember(db, mccId, 50))) === null)
    check('MCC without plan: shop creation refused', !!(await refused(L.assertCanCreateShop(db, mccId))))

    // Plan mapping for the other plans.
    const fake = (id: string, syncs: number | null): import('../lib/entitlements').Entitlements => ({
      accountId: 'x', type: 'user', standing: 'active', locked: false,
      plan: { id, name: id, feedLimit: null, shopLimit: null, userLimit: null, syncsPerDay: syncs },
    })
    check('Advanced: 12 h yes, 6 h no', E.frequencyAllowed(fake('advanced', 2), '12h') && !E.frequencyAllowed(fake('advanced', 2), '6h'))
    check('Pro: 6 h yes, hourly no', E.frequencyAllowed(fake('pro', 5), '6h') && !E.frequencyAllowed(fake('pro', 5), 'hourly'))
    check('Pro: hourly capped to 6 h', E.capFrequency(fake('pro', 5), 'hourly') === '6h')
  } finally {
    const { data: projs } = await db.from('projects').select('id').eq('account_id', accountId)
    const ids = (projs ?? []).map((p) => p.id as string)
    if (ids.length) {
      await db.from('feeds').delete().in('project_id', ids)
      await db.from('projects').delete().in('id', ids)
    }
    await db.from('subscriptions').delete().eq('account_id', accountId)
    await db.from('accounts').delete().in('id', [accountId, mccId])
    const { count } = await db.from('accounts').select('id', { count: 'exact', head: true }).like('name', `${tag}%`)
    console.log(`\ncleanup: ${count === 0 ? 'temporary account removed' : `${count} row(s) left — check accounts named ${tag}*`}`)
  }
  console.log(failures === 0 ? 'PASS' : `${failures} FAILED`)
  process.exitCode = failures ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
