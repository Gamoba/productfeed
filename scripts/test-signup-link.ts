// Test helper for the signup flow while no custom SMTP is set up.
//
// Does what /signup does (lib/signup.ts startSignup), but prints the link
// instead of emailing it:
//
//   npx tsx scripts/test-signup-link.ts <email> "<company>" ["<name>"] [--ref <code>] [--plan <token>] [--origin http://localhost:3000]
//
// Open the printed link in the browser, choose a password, and the signup
// finishes as for a real customer (User account → Billing).
//
// Clean up afterwards (removes the login, its account and billing rows; the
// Stripe test customer and subscription stay in Stripe's test mode):
//
//   npx tsx scripts/test-signup-link.ts --cleanup <email>
//
// Refuses any address that has a login it didn't make (no pending signup or
// test marker), so it can't touch real users.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join } from 'path'

try {
  for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const [k, ...rest] = line.split('=')
    if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
  }
} catch {
  // use the environment as is
}

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i === -1) return null
  const v = args[i + 1]
  args.splice(i, 2)
  return v ?? null
}

async function findUser(email: string) {
  const { data: id } = await db.rpc('auth_user_id_by_email', { p_email: email })
  if (!id) return null
  const { data } = await db.auth.admin.getUserById(id as string)
  return data.user
}

async function create() {
  const ref = flag('--ref')
  const plan = flag('--plan')
  const origin = flag('--origin') ?? 'http://localhost:3000'
  const [rawEmail, company, name = 'Test User'] = args
  const email = rawEmail?.trim().toLowerCase()
  if (!email || !company) {
    console.error('Usage: npx tsx scripts/test-signup-link.ts <email> "<company>" ["<name>"] [--ref <code>]')
    process.exit(1)
  }
  if (await findUser(email)) {
    console.error(`${email} already has a login. Use another address, or --cleanup it first if it was a test.`)
    process.exit(1)
  }

  const { data, error } = await db.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo: `${origin}/auth/invite`, data: { full_name: name } },
  })
  if (error || !data.user || !data.properties?.action_link) throw error ?? new Error('No link')

  const { error: metaErr } = await db.auth.admin.updateUserById(data.user.id, {
    app_metadata: { ...(data.user.app_metadata ?? {}), pending_signup: { company, ref, plan }, signup_test: true },
  })
  if (metaErr) throw metaErr

  console.log(`\nSignup link for ${email} (${company}${ref ? `, ref ${ref}` : ''}${plan ? ', custom plan link' : ''}):\n\n${data.properties.action_link}\n`)
  console.log('It works once and expires in 24 hours.')
}

async function cleanup(rawEmail: string) {
  const email = rawEmail.trim().toLowerCase()
  const user = await findUser(email)
  if (!user) return console.log(`${email}: no login, nothing to do.`)
  if (!(user.app_metadata as Record<string, unknown>)?.signup_test) {
    console.error(`${email} was not made by this script. Refusing to delete it.`)
    process.exit(1)
  }

  const { data: accounts } = await db.from('accounts').select('id, name').eq('created_by', user.id)
  for (const a of (accounts ?? []) as { id: string; name: string }[]) {
    const { data: members } = await db.from('account_members').select('user_id').eq('account_id', a.id)
    if ((members ?? []).some((m) => m.user_id !== user.id)) {
      console.error(`Account ${a.name} has other members; left in place.`)
      continue
    }
    const { count } = await db.from('projects').select('id', { count: 'exact', head: true }).eq('account_id', a.id)
    if ((count ?? 0) > 0) {
      console.error(`Account ${a.name} has shops; left in place.`)
      continue
    }
    const { data: refs } = await db.from('referrals').select('id').eq('user_account_id', a.id)
    const refIds = ((refs ?? []) as { id: string }[]).map((r) => r.id)
    if (refIds.length) await db.from('commissions').delete().in('referral_id', refIds)
    await db.from('referrals').delete().eq('user_account_id', a.id)
    await db.from('access_grants').delete().eq('user_account_id', a.id)
    await db.from('subscriptions').delete().eq('account_id', a.id)
    await db.from('stripe_customers').delete().eq('account_id', a.id)
    await db.from('account_members').delete().eq('account_id', a.id)
    const { error } = await db.from('accounts').delete().eq('id', a.id)
    console.log(error ? `Account ${a.name}: ${error.message}` : `Removed account ${a.name}`)
  }
  const { error } = await db.auth.admin.deleteUser(user.id)
  console.log(error ? `Login: ${error.message}` : `Removed login ${email}`)
}

const cleanupEmail = flag('--cleanup')
;(cleanupEmail ? cleanup(cleanupEmail) : create()).catch((e) => {
  console.error(e)
  process.exitCode = 1
})
