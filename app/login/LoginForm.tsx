'use client'

import { useActionState } from 'react'
import { signIn, type AuthState } from './actions'

const initialState: AuthState = { error: null, mode: 'login' }

// Login. New User accounts sign up on /signup (lib/signup.ts), which creates
// the login server-side; Supabase's own public signup stays switched off.
//
// `next` is where to go after signing in (e.g. back to the consent page when
// Claude asks for access). signIn only follows it when it is a path on this site.
export function LoginForm({ next }: { next: string | null }) {
  const [state, formAction, isPending] = useActionState(signIn, initialState)

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Sign in</h1>
          <p className="text-sm text-gray-500 mb-6">
            Sign in with your email and password.
          </p>

          <form action={formAction} className="space-y-4">
            {next && <input type="hidden" name="next" value={next} />}
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
                className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
                disabled={isPending}
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={6}
                placeholder="••••••••"
                className="w-full rounded-lg border border-gray-300 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 shadow-xs focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50"
                disabled={isPending}
              />
            </div>

            {state.error && (
              <p className="text-sm text-red-600" role="alert">
                {state.error}
              </p>
            )}

            <button
              type="submit"
              disabled={isPending}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? 'Please wait…' : 'Sign in'}
            </button>
          </form>
          <p className="text-sm text-gray-500 mt-6">
            New to FeedFlow?{' '}
            <a href="/signup" className="text-indigo-600 hover:underline">
              Create an account
            </a>
          </p>
        </div>
      </div>
    </main>
  )
}
