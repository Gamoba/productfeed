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

// Self-service signup is CLOSED (security hardening M1). Accounts are created
// manually by the administrator in the Supabase dashboard. This action no longer
// registers anyone — it just refuses, so even if the UI path were re-exposed (or
// the action were called directly) nobody can register through the app.
//
// NOTE: this is the APP-level half. The authoritative switch is in the Supabase
// dashboard (Authentication → "Allow new users to sign up" = OFF); the public
// anon key can otherwise hit Supabase's /auth/v1/signup directly, bypassing this.
export async function signUp(prevState: AuthState): Promise<AuthState> {
  return {
    ...prevState,
    mode: 'login',
    error: 'Sign-up is closed. Contact the administrator to get an account.',
  }
}
