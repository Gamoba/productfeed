import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/feeds'
import { changeRole, removeMember } from '@/lib/accountMembers'
import { errorResponse } from '@/lib/errors'
import { sessionUserId } from '../_shared'

type Ctx = { params: Promise<{ accountId: string; userId: string }> }

// PATCH { role } — change a member's role.
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { accountId, userId } = await params
    const me = await sessionUserId()
    const body = (await req.json().catch(() => ({}))) as { role?: unknown }
    await changeRole(adminDb(), me, accountId, userId, body.role)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'PATCH /api/accounts/[accountId]/members/[userId]')
  }
}

// DELETE — remove a member from the account.
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { accountId, userId } = await params
    const me = await sessionUserId()
    await removeMember(adminDb(), me, accountId, userId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err, 'DELETE /api/accounts/[accountId]/members/[userId]')
  }
}
