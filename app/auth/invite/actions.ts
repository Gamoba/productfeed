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
    return { error: 'Adgangskoden skal være mindst 8 tegn.' }
  }
  if (!input.accessToken || !input.refreshToken) {
    return { error: 'Linket mangler oplysninger. Bed om et nyt.' }
  }

  const supabase = await createSupabaseServerClient()
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
  })
  if (sessionError) return { error: 'Linket er udløbet eller allerede brugt. Bed om et nyt.' }

  const { error } = await supabase.auth.updateUser({ password: input.password })
  if (error) return { error: error.message }
  return {}
}
