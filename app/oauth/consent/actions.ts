'use server'

import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'

// Approve or deny an MCP client's access request. Supabase returns the URL to
// send the browser back to (Claude), carrying the code or an access_denied.
export async function decideAuthorization(formData: FormData) {
  const authorizationId = String(formData.get('authorization_id') ?? '')
  const approve = formData.get('decision') === 'approve'

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${authorizationId}`)}`)

  const { data, error } = approve
    ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
    : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true })
  if (error || !data?.redirect_url) {
    console.error('[oauth consent] decision failed:', error?.message)
    redirect(`/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`)
  }
  redirect(data.redirect_url)
}
