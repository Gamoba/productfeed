'use client'

import { useEffect, useState } from 'react'
import { acceptInvite } from './actions'
import './invite.css'

type Tokens = { accessToken: string; refreshToken: string }

// Landing page for an invite link (Agency users → Invitér bruger). Supabase
// verifies the link and sends the browser here with the session in the URL
// hash; the user picks a password and is signed in.
export default function InvitePage() {
  // The hash is only readable in the browser, so it is read after mount.
  const [tokens, setTokens] = useState<Tokens | null | 'none'>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const p = new URLSearchParams(window.location.hash.slice(1))
    const accessToken = p.get('access_token')
    const refreshToken = p.get('refresh_token')
    // Keep the tokens out of the address bar and history.
    window.history.replaceState(null, '', window.location.pathname)
    /* eslint-disable react-hooks/set-state-in-effect -- one-time read of the URL hash */
    if (p.get('error')) setLinkError(p.get('error_description') ?? 'Linket virker ikke.')
    setTokens(accessToken && refreshToken ? { accessToken, refreshToken } : 'none')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!tokens || tokens === 'none') return
    if (password !== repeat) {
      setError('De to adgangskoder er ikke ens.')
      return
    }
    setBusy(true)
    setError(null)
    const r = await acceptInvite({ ...tokens, password })
    if (r.error) {
      setError(r.error)
      setBusy(false)
      return
    }
    window.location.assign('/')
  }

  return (
    <main className="iv">
      <div className="iv-card card">
        <span className="iv-brand">FeedFlow</span>
        {tokens === null ? (
          <p className="iv-muted">Åbner invitationen…</p>
        ) : tokens === 'none' ? (
          <>
            <h1>Linket virker ikke</h1>
            <p className="iv-muted">
              {linkError ?? 'Invitationen er udløbet eller allerede brugt.'} Bed den, der inviterede dig, om et nyt link
              under Agency users.
            </p>
            <a href="/login" className="link">
              Gå til log ind
            </a>
          </>
        ) : (
          <form onSubmit={submit} className="iv-form">
            <h1>Velkommen</h1>
            <p className="iv-muted">Vælg en adgangskode. Du logger ind med din e-mail og den fremover.</p>
            <label>
              <span>Adgangskode</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </label>
            <label>
              <span>Gentag adgangskode</span>
              <input
                type="password"
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                minLength={8}
                required
              />
            </label>
            {error && <p className="note warn">{error}</p>}
            <button type="submit" className="wl-btn-primary" disabled={busy}>
              {busy ? 'Gemmer…' : 'Gem og fortsæt'}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}
