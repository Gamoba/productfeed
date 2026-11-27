import { NextResponse } from 'next/server'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { listOwnAccounts, rememberCurrentAccount } from '@/lib/currentAccount'
import { errorResponse } from '@/lib/errors'

// POST /api/accounts/current { accountId } — the account switcher
// (lib/currentAccount.ts). Only an account the user is a member of.
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const body = (await req.json().catch(() => ({}))) as { accountId?: unknown }
    const accounts = await listOwnAccounts(adminDb(), user.id)
    const account = accounts.find((a) => a.id === body.accountId)
    if (!account) return NextResponse.json({ error: 'You are not a member of that account' }, { status: 404 })
    await rememberCurrentAccount(account.id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'POST /api/accounts/current')
  }
}
