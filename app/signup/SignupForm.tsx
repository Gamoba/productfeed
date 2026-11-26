'use client'

import { useActionState } from 'react'
import { signUp, type SignupState } from './actions'
import '../auth/invite/invite.css'

const initial: SignupState = { status: 'idle', error: null }

type PlanOffer = { token: string; name: string; email: string | null }

export function SignupForm({
  referral,
  plan,
  planLinkInvalid,
}: {
  referral: string | null
  plan: PlanOffer | null
  planLinkInvalid: boolean
}) {
  const [state, action, pending] = useActionState(signUp, initial)

  return (
    <main className="iv">
      <div className="iv-card card">
        <span className="iv-brand">FeedFlow</span>
        {state.status === 'sent' ? (
          <>
            <h1>Check your email</h1>
            <p className="iv-muted">
              We sent a link to {state.email}. Open it to choose a password and set up your account. The link works for 24
              hours.
            </p>
            <p className="iv-muted">
              Already have an account?{' '}
              <a href="/login" className="link">
                Sign in
              </a>
            </p>
          </>
        ) : (
          <form action={action} className="iv-form">
            <h1>Create your account</h1>
            {plan ? (
              <p className="note">
                You&rsquo;re signing up for <b>{plan.name}</b>, the plan we agreed with you. It&rsquo;s waiting on the
                Billing page once you&rsquo;ve confirmed your email.
              </p>
            ) : (
              <p className="iv-muted">
                Set up product feeds for your shop. You choose a plan after confirming your email.
              </p>
            )}
            {planLinkInvalid && (
              <p className="note warn">
                This plan link has expired or has already been used. You can still sign up and choose a plan; ask us for a new
                link if you have an agreement with us.
              </p>
            )}
            {referral && <input type="hidden" name="ref" value={referral} />}
            {plan && <input type="hidden" name="plan" value={plan.token} />}
            <label>
              <span>Your name</span>
              <input name="name" autoComplete="name" required maxLength={120} disabled={pending} />
            </label>
            <label>
              <span>Company</span>
              <input name="company" autoComplete="organization" required maxLength={120} disabled={pending} />
            </label>
            <label>
              <span>Work email</span>
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                disabled={pending}
                defaultValue={plan?.email ?? undefined}
                readOnly={!!plan?.email}
              />
            </label>
            {state.error && <p className="note warn">{state.error}</p>}
            <button type="submit" className="wl-btn-primary" disabled={pending}>
              {pending ? 'Sending…' : 'Continue'}
            </button>
            <p className="iv-muted">
              Already have an account?{' '}
              <a href="/login" className="link">
                Sign in
              </a>
            </p>
          </form>
        )}
      </div>
    </main>
  )
}
