import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/feeds'
import { inviteUser, listAccountUsers } from '@/lib/accountMembers'
import { enforceRateLimit } from '@/lib/rateLimit'
import { errorResponse } from '@/lib/errors'
import { inviteRedirect, sessionUserId } from './_shared'

type Ctx = { params: Promise<{ accountId: string }> }

// GET — the account's users. Any member may read it.
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { accountId } = await params
    const me = await sessionUserId()
    return NextResponse.json(await listAccountUsers(adminDb(), me, accountId))
  } catch (err) {
    return errorResponse(err, 'GET /api/accounts/[accountId]/members')
  }
}

// POST { email, name?, role } — invite. Owners and admins only.
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { accountId } = await params
    const me = await sessionUserId()
    await enforceRateLimit(me, 'account_invite')
    const body = (await req.json().catch(() => ({}))) as { email: unknown; name?: unknown; role: unknown }
    const result = await inviteUser(adminDb(), me, accountId, body, inviteRedirect(req))
    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err, 'POST /api/accounts/[accountId]/members')
  }
}
