'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'

// Finishes an invite: turns the tokens from the invite link into a cookie
// session, then sets the password the user chose. Runs on the server so the
// session lands in the same cookies every other page reads.
export async function acceptInvite(input: {
  accessToken: string
  refreshToken: string
  password: string
}): Promise<{ error?: string }> {
  if (typeof input.password !== 'string' || input.password.length < 8) {
    return { error: 'The password must be at least 8 characters.' }
  }
  if (!input.accessToken || !input.refreshToken) {
    return { error: 'The link is missing details. Ask for a new one.' }
  }

  const supabase = await createSupabaseServerClient()
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
  })
  if (sessionError) return { error: 'The link has expired or has already been used. Ask for a new one.' }

  const { error } = await supabase.auth.updateUser({ password: input.password })
  if (error) return { error: error.message }
  return {}
}
