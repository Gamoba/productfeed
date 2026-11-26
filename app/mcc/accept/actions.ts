'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { clientMessage } from '@/lib/errors'
import { acceptMccInvite } from '@/lib/mcc'

export async function acceptMccAction(token: string): Promise<{ error?: string }> {
  try {
    const supabase = await createSupabaseServerClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return { error: 'Sign in again.' }
    await acceptMccInvite(adminDb(), user, { token })
    return {}
  } catch (err) {
    return { error: clientMessage(err, 'acceptMccAction') }
  }
}
