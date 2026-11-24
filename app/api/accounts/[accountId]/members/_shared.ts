import { createSupabaseServerClient } from '@/lib/supabase-server'
import { AppError } from '@/lib/errors'

// Session user for the members routes, or a 401 AppError.
export async function sessionUserId(): Promise<string> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new AppError('Unauthorized', 401)
  return user.id
}

// Where an invite link lands: the page that sets the password.
export function inviteRedirect(req: Request): string {
  return `${new URL(req.url).origin}/auth/invite`
}
