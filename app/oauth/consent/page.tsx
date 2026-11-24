import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getMemberships } from '@/lib/accounts'
import { decideAuthorization } from './actions'
import './consent.css'

// OAuth consent for MCP clients (Claude's FeedFlow connector).
//
// Supabase Auth is the authorization server (OAuth 2.1 server, enabled in the
// Supabase dashboard with this page as the authorization path). Claude sends
// the user to Supabase, Supabase sends them here with an authorization_id, and
// approving gives Claude a token that acts as this user: it reaches exactly the
// shops the user's agency membership gives, nothing more.
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string | string[] }>
}) {
  const { authorization_id } = await searchParams
  const authorizationId = typeof authorization_id === 'string' ? authorization_id : null
  if (!authorizationId) return <Shell title="Linket er ufuldstændigt" text="Start forbindelsen igen fra Claude." />

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${authorizationId}`)}`)
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
  if (error || !data) {
    return <Shell title="Anmodningen er udløbet" text="Start forbindelsen igen fra Claude." />
  }
  // Already approved before: Supabase hands back the redirect straight away.
  if (!('authorization_id' in data)) redirect(data.redirect_url)

  const db = adminDb()
  const ids = (await getMemberships(db, user.id)).map((m) => m.account_id)
  const { data: accounts } = ids.length
    ? await db.from('accounts').select('name').in('id', ids)
    : { data: [] as { name: string }[] }
  const agencies = ((accounts ?? []) as { name: string }[]).map((a) => a.name).filter(Boolean)

  return (
    <main className="oc">
      <div className="oc-card card">
        <span className="oc-brand">FeedFlow</span>
        <h1>{data.client.name || 'En app'} vil have adgang til FeedFlow</h1>
        <p className="oc-muted">
          Logget ind som <strong>{user.email}</strong>. Den får samme adgang som dig
          {agencies.length ? <> i {agencies.join(', ')}</> : null}, til alle de shops du kan åbne.
        </p>
        <ul className="oc-list">
          <li>Læse shops, feeds, varer, mapping, regler og performance</li>
          <li>Ændre mapping, regler for inkludér / ekskludér og feedets indstillinger. Ændringer venter på godkendelse, medmindre jeres bureau har slået det fra.</li>
          <li>Starte en hentning af varer (højst én gang i timen pr. feed)</li>
          <li>Skriver aldrig til jeres Shopify-butik og kan ikke ændre forbindelser og brugere eller slette noget</li>
        </ul>
        <form action={decideAuthorization} className="oc-actions">
          <input type="hidden" name="authorization_id" value={data.authorization_id} />
          <button type="submit" name="decision" value="approve" className="wl-btn-primary">
            Giv adgang
          </button>
          <button type="submit" name="decision" value="deny" className="wl-btn-secondary">
            Annullér
          </button>
        </form>
        <p className="oc-small">Du kan afbryde forbindelsen når som helst under Shop › API / MCP.</p>
      </div>
    </main>
  )
}

function Shell({ title, text }: { title: string; text: string }) {
  return (
    <main className="oc">
      <div className="oc-card card">
        <span className="oc-brand">FeedFlow</span>
        <h1>{title}</h1>
        <p className="oc-muted">{text}</p>
      </div>
    </main>
  )
}
