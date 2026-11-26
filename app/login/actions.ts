'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { redirect } from 'next/navigation'

export type AuthState = {
  error: string | null
  mode: 'login' | 'signup'
}

export async function signIn(
  prevState: AuthState,
  formData: FormData
): Promise<AuthState> {
  const email = formData.get('email')
  const password = formData.get('password')

  if (!email || typeof email !== 'string' || !email.trim()) {
    return { ...prevState, error: 'Enter a valid email address.' }
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return { ...prevState, error: 'Password must be at least 6 characters.' }
  }

  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  })

  if (error) {
    return { ...prevState, error: error.message }
  }

  redirect(safeNext(formData.get('next')))
}

// Only a path on this site: "/x" yes, "//evil.com" or "https://…" no, so the
// login form can't be used to send people elsewhere after signing in.
function safeNext(v: FormDataEntryValue | null): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return '/'
  return v
}

// Supabase's own signup stays CLOSED (security hardening M1): the dashboard
// switch "Allow new users to sign up" must stay OFF, or the public anon key
// can hit /auth/v1/signup directly. Open signup for User accounts goes through
// app/signup (lib/signup.ts), which creates the login with the admin API, rate
// limited and with email confirmation. This old action still only refuses.
export async function signUp(prevState: AuthState): Promise<AuthState> {
  return {
    ...prevState,
    mode: 'login',
    error: 'Sign-up is closed. Contact the administrator to get an account.',
  }
}
