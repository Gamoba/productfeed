import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

export async function createSupabaseServerClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Called from a Server Component — session refresh is handled by middleware
          }
        },
      },
    }
  )
}

/**
 * The signed-in user, from the session cookie, checked on this server.
 *
 * getClaims() verifies the session token against the project's public signing
 * key (ES256; fetched once and cached), where getUser() asked Supabase's auth
 * server over the network on every request. An expired session is refreshed
 * the same way as before. The difference: a session that was signed out
 * elsewhere stays valid until its token expires (up to an hour), so the most
 * sensitive places (granting an assistant access, managing account members)
 * still use getUser().
 *
 * Returns getUser()'s shape, with the user built from the token's claims (id,
 * email, metadata), which is all the app reads.
 */
export async function getSessionUser(supabase: SupabaseClient): Promise<{ data: { user: User | null } }> {
  const { data, error } = await supabase.auth.getClaims()
  const c = data?.claims
  if (error || !c?.sub) return { data: { user: null } }
  const user = {
    id: c.sub,
    email: c.email,
    phone: c.phone,
    aud: c.aud,
    role: c.role,
    is_anonymous: c.is_anonymous,
    app_metadata: c.app_metadata ?? {},
    user_metadata: c.user_metadata ?? {},
    created_at: '',
  } as unknown as User
  return { data: { user } }
}
