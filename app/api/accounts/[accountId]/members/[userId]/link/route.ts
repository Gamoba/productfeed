import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/feeds'
import { newInviteLink } from '@/lib/accountMembers'
import { enforceRateLimit } from '@/lib/rateLimit'
import { errorResponse } from '@/lib/errors'
import { inviteRedirect, sessionUserId } from '../../_shared'

type Ctx = { params: Promise<{ accountId: string; userId: string }> }

// POST — a fresh invite link for someone who never signed in.
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { accountId, userId } = await params
    const me = await sessionUserId()
    await enforceRateLimit(me, 'account_invite')
    const link = await newInviteLink(adminDb(), me, accountId, userId, inviteRedirect(req))
    return NextResponse.json({ link })
  } catch (err) {
    return errorResponse(err, 'POST /api/accounts/[accountId]/members/[userId]/link')
  }
}
