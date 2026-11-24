import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/feeds'
import { changeRole, isRole, listAccountUsers, removeMember } from '@/lib/accountMembers'
import { logActivity } from '@/lib/activity'
import { ROLE_LABEL } from '@/app/components/shell/nav'
import { errorResponse } from '@/lib/errors'
import { sessionUser } from '../_shared'

type Ctx = { params: Promise<{ accountId: string; userId: string }> }

// PATCH { role } — change a member's role.
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { accountId, userId } = await params
    const user = await sessionUser()
    const body = (await req.json().catch(() => ({}))) as { role?: unknown }
    const db = adminDb()
    const target = (await listAccountUsers(db, user.id, accountId)).members.find((m) => m.userId === userId)
    await changeRole(db, user.id, accountId, userId, body.role)
    if (target && isRole(body.role) && target.role !== body.role) {
      await logActivity(db, {
        user,
        accountId,
        area: 'Access',
        action: `Role changed for ${target.email}`,
        before: ROLE_LABEL[target.role],
        after: ROLE_LABEL[body.role],
      })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'PATCH /api/accounts/[accountId]/members/[userId]')
  }
}

// DELETE — remove a member from the account.
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { accountId, userId } = await params
    const user = await sessionUser()
    const db = adminDb()
    const target = (await listAccountUsers(db, user.id, accountId)).members.find((m) => m.userId === userId)
    await removeMember(db, user.id, accountId, userId)
    await logActivity(db, { user, accountId, area: 'Access', action: 'User removed', before: target?.email ?? null })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'DELETE /api/accounts/[accountId]/members/[userId]')
  }
}
