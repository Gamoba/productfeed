import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb } from '@/lib/feeds'
import { getMemberships } from '@/lib/accounts'
import { decideAuthorization } from './actions'
import './consent.css'

// OAuth consent for MCP clients (Claude's Kompara connector).
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
  if (!authorizationId) return <Shell title="The link is incomplete" text="Start the connection again from Claude." />

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${authorizationId}`)}`)
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
  if (error || !data) {
    return <Shell title="The request has expired" text="Start the connection again from Claude." />
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
        <span className="oc-brand">Kompara</span>
        <h1>{data.client.name || 'An app'} wants access to Kompara</h1>
        <p className="oc-muted">
          Signed in as <strong>{user.email}</strong>. It gets the same access as you
          {agencies.length ? <> in {agencies.join(', ')}</> : null}, on every shop you can open.
        </p>
        <ul className="oc-list">
          <li>Read shops, feeds, products, mapping, rules, labels, AI titles and performance</li>
          <li>Change mapping, include / exclude rules, feed settings, Google Ads labels and AI Titles, and generate AI titles. Changes wait for approval unless your agency has turned that off.</li>
          <li>Start a product sync (at most once an hour per feed)</li>
          <li>Never writes to your Shopify store, and can&apos;t change connections, users or delete anything</li>
        </ul>
        <form action={decideAuthorization} className="oc-actions">
          <input type="hidden" name="authorization_id" value={data.authorization_id} />
          <button type="submit" name="decision" value="approve" className="wl-btn-primary">
            Allow access
          </button>
          <button type="submit" name="decision" value="deny" className="wl-btn-secondary">
            Cancel
          </button>
        </form>
        <p className="oc-small">You can disconnect it at any time under Shop › API / MCP.</p>
      </div>
    </main>
  )
}

function Shell({ title, text }: { title: string; text: string }) {
  return (
    <main className="oc">
      <div className="oc-card card">
        <span className="oc-brand">Kompara</span>
        <h1>{title}</h1>
        <p className="oc-muted">{text}</p>
      </div>
    </main>
  )
}
