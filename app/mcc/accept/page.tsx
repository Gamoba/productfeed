import { createHash } from 'crypto'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { AcceptForm } from './AcceptForm'
import '../../auth/invite/invite.css'

// An agency invite for someone who already has a login (lib/mcc.ts
// inviteMcc). Shows what it is and asks for a click: a link preview or
// prefetch must not use up the invite.
export default async function AcceptMccPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect(`/login?next=${encodeURIComponent(`/mcc/accept?token=${token ?? ''}`)}`)

  const { data } = token
    ? await adminDb()
        .from('mcc_signup_invites')
        .select('email, name, expires_at, used_at')
        .eq('token_hash', createHash('sha256').update(token).digest('hex'))
        .maybeSingle<{ email: string; name: string | null; expires_at: string; used_at: string | null }>()
    : { data: null }

  const problem = !data
    ? 'The invitation link does not work.'
    : data.used_at
      ? 'The invitation has already been used.'
      : new Date(data.expires_at) < new Date()
        ? 'The invitation has expired. Ask Gamoba for a new one.'
        : (user.email ?? '').toLowerCase() !== data.email.toLowerCase()
          ? `The invitation is for ${data.email}, but you're signed in as ${user.email}.`
          : null

  return (
    <main className="iv">
      <div className="iv-card card">
        <span className="iv-brand">Kompara</span>
        {problem ? (
          <>
            <h1>Can&rsquo;t set up the agency</h1>
            <p className="iv-muted">{problem}</p>
            <Link href="/" className="link">
              Go to the app
            </Link>
          </>
        ) : (
          <>
            <h1>Set up {data!.name ?? 'your agency'}</h1>
            <p className="iv-muted">
              As an agency you work on your clients&rsquo; feeds and earn a share of what the clients you refer pay. Your login
              stays the same.
            </p>
            <AcceptForm token={token!} />
          </>
        )}
      </div>
    </main>
  )
}
