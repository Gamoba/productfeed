import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/feeds'
import { inviteUser, listAccountUsers } from '@/lib/accountMembers'
import { enforceRateLimit } from '@/lib/rateLimit'
import { errorResponse } from '@/lib/errors'
import { inviteRedirect, sessionUser, sessionUserId } from './_shared'
import { logActivity } from '@/lib/activity'
import { ROLE_LABEL } from '@/app/components/shell/nav'
import { isRole } from '@/lib/accountMembers'

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
    const user = await sessionUser()
    await enforceRateLimit(user.id, 'account_invite')
    const body = (await req.json().catch(() => ({}))) as { email: unknown; name?: unknown; role: unknown }
    const db = adminDb()
    const result = await inviteUser(db, user.id, accountId, body, inviteRedirect(req))
    await logActivity(db, {
      user,
      accountId,
      area: 'Access',
      action: result.kind === 'added' ? 'User added' : 'User invited',
      after: `${result.email}${isRole(body.role) ? ` · ${ROLE_LABEL[body.role]}` : ''}`,
    })
    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err, 'POST /api/accounts/[accountId]/members')
  }
}
