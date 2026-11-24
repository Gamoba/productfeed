'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { MissingScope } from '@/lib/shopifyScopes'
import './connect.css'

export type ProjectSource = 'shopify' | 'feed_url'

export type ConnectResult = {
  connection_status: string
  source_type: ProjectSource
  // Shopify: the shop domain. Feed URL: the feed URL.
  shop: string
  feedUrl: string | null
  productCount: number | null
  // Shopify scopes the token lacks; always empty for a feed URL.
  missingScopes: MissingScope[]
  last_verified_at: string
}

// Connect a project to its product source: a Shopify store (credentials) or a
// public product feed URL (e.g. a Google Shopping feed exported by Umbraco).
//
// Shopify: the access token is write-only from the client's perspective — we
// send it once, the server probes and stores it encrypted, and it's never read
// back. Feed URL: the server downloads the feed once to check it contains
// products before saving.
export function ProjectConnectModal({
  projectId,
  mode,
  initialSource = 'shopify',
  initialShopUrl,
  initialFeedUrl,
  onClose,
  onConnected,
}: {
  projectId: string
  mode: 'connect' | 'rotate'
  initialSource?: ProjectSource
  initialShopUrl?: string | null
  initialFeedUrl?: string | null
  onClose: () => void
  onConnected: (result: ConnectResult) => void
}) {
  const [source, setSource] = useState<ProjectSource>(initialSource)
  const [shopUrl, setShopUrl] = useState(initialShopUrl ?? '')
  const [token, setToken] = useState('')
  const [feedUrl, setFeedUrl] = useState(initialFeedUrl ?? '')
  // Optional HTTP Basic Auth login for a protected feed. Write-only, like the
  // Shopify token: sent once, stored encrypted, never read back.
  const [authUser, setAuthUser] = useState('')
  const [authPass, setAuthPass] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  // "rotate" only means "replace the token" for the source the project already
  // uses; switching source is always a fresh connect.
  const rotating = mode === 'rotate' && source === initialSource
  const switching = mode === 'rotate' && source !== initialSource

  const canSubmit =
    !submitting &&
    (source === 'shopify' ? shopUrl.trim() !== '' && token.trim() !== '' : feedUrl.trim() !== '')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    setWarning(null)
    try {
      if (source === 'feed_url') {
        const res = await fetch(`/api/projects/${projectId}/connect-feed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feed_url: feedUrl.trim(),
            auth_username: authUser.trim(),
            auth_password: authPass,
            // Re-saving a feed-URL project without retyping the login keeps the
            // stored one (server-side, only for the same origin).
            keep_auth: rotating && authUser.trim() === '',
          }),
        })
        const data = (await res.json()) as {
          connection_status?: string
          last_verified_at?: string
          feed_url?: string
          productCount?: number
          error?: string
        }
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`)
        onConnected({
          connection_status: data.connection_status ?? 'connected',
          source_type: 'feed_url',
          shop: data.feed_url ?? feedUrl.trim(),
          feedUrl: data.feed_url ?? feedUrl.trim(),
          productCount: data.productCount ?? null,
          missingScopes: [],
          last_verified_at: data.last_verified_at ?? new Date().toISOString(),
        })
        onClose()
        return
      }

      const res = await fetch(`/api/projects/${projectId}/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_url: shopUrl.trim(), access_token: token.trim() }),
      })
      const data = (await res.json()) as Partial<ConnectResult> & { error?: string }
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }

      const result: ConnectResult = {
        connection_status: data.connection_status ?? 'connected',
        source_type: 'shopify',
        shop: data.shop ?? shopUrl.trim(),
        feedUrl: null,
        productCount: null,
        missingScopes: data.missingScopes ?? [],
        last_verified_at: data.last_verified_at ?? new Date().toISOString(),
      }

      if (result.missingScopes.length > 0) {
        // The token authenticates, but something will be degraded. Hold the
        // modal open so the user reads it here, where they still have the
        // Shopify app settings in mind — not later, from a feed full of IDs.
        setWarning(
          'Connected, but the token is missing access: ' +
            result.missingScopes.map((s) => `${s.handle}: ${s.impact}`).join(' ')
        )
        onConnected(result)
      } else {
        onConnected(result)
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect')
    } finally {
      setSubmitting(false)
    }
  }

  const title =
    mode === 'connect'
      ? 'Connect product source'
      : source === 'feed_url'
        ? rotating
          ? 'Change feed URL'
          : 'Switch to feed URL'
        : rotating
          ? 'Change Shopify token'
          : 'Switch to Shopify'

  const submitLabel = submitting
    ? source === 'feed_url'
      ? 'Checking the feed…'
      : 'Checking the token…'
    : source === 'feed_url'
      ? rotating
        ? 'Save feed URL'
        : 'Connect feed'
      : rotating
        ? 'Change token'
        : 'Connect'

  // Portalled to <body> so no ancestor (a table row, an animated page) can clip
  // or contain the fixed backdrop.
  return createPortal(
    <div className="pc-overlay" onClick={onClose}>
      <div
        className="pc-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>{title}</h2>
        <form onSubmit={submit} className="pc-body">
          <div className="pc-field">
            <span>Source</span>
            <div role="radiogroup" aria-label="Product source" className="pc-seg">
              <SourceOption
                label="Shopify"
                hint="Admin API token"
                selected={source === 'shopify'}
                onSelect={() => {
                  setSource('shopify')
                  setError(null)
                }}
              />
              <SourceOption
                label="Feed URL"
                hint="Google Shopping XML"
                selected={source === 'feed_url'}
                onSelect={() => {
                  setSource('feed_url')
                  setError(null)
                }}
              />
            </div>
          </div>

          {source === 'shopify' ? (
            <>
              <p className="pc-muted">
                We check the token against Shopify before saving it. It is stored encrypted and never shown again. FeedFlow
                only reads and never changes anything in the shop.
              </p>
              <label className="pc-field">
                <span>Shop URL</span>
                <input
                  type="text"
                  value={shopUrl}
                  onChange={(e) => setShopUrl(e.target.value)}
                  placeholder="your-shop.myshopify.com"
                  autoFocus={mode === 'connect'}
                  className="pc-inp"
                  required
                />
              </label>
              <label className="pc-field">
                <span>{rotating ? 'New token' : 'Admin API token'}</span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={rotating ? 'Paste the new token' : 'shpat_…'}
                  autoComplete="off"
                  autoFocus={rotating}
                  className="pc-inp"
                  required
                />
              </label>
            </>
          ) : (
            <>
              <p className="pc-muted">
                A public product feed, e.g. the Google Shopping feed an Umbraco site exports. We fetch it once to check
                it has products before saving, and again at every sync.
              </p>
              <label className="pc-field">
                <span>Feed URL</span>
                <input
                  type="url"
                  value={feedUrl}
                  onChange={(e) => setFeedUrl(e.target.value)}
                  placeholder="https://example.com/google-feed.xml"
                  autoFocus
                  className="pc-inp"
                  required
                />
              </label>
              <div className="pc-field">
                <span>Login (optional)</span>
                <div className="pc-two">
                  <input
                    type="text"
                    value={authUser}
                    onChange={(e) => setAuthUser(e.target.value)}
                    placeholder="Username"
                    autoComplete="off"
                    aria-label="Username for the feed"
                    className="pc-inp"
                  />
                  <input
                    type="password"
                    value={authPass}
                    onChange={(e) => setAuthPass(e.target.value)}
                    placeholder="Password"
                    autoComplete="new-password"
                    aria-label="Password for the feed"
                    className="pc-inp"
                  />
                </div>
                <small>
                  {rotating
                    ? 'Only for feeds behind a login (HTTP Basic Auth). Leave the fields empty to keep the saved login on the same domain.'
                    : 'Only for feeds behind a login (HTTP Basic Auth). Stored encrypted and never shown again.'}
                </small>
              </div>
            </>
          )}

          {switching && (
            <p className="note warn">
              {source === 'feed_url'
                ? 'This replaces the Shopify connection, and the saved token is deleted. The feeds fetch products from the feed URL at the next sync.'
                : 'This replaces the feed URL. The feeds fetch products from Shopify at the next sync.'}
            </p>
          )}
          {error && <p className="note warn">{error}</p>}
          {warning && <p className="note warn">{warning}</p>}

          <div className="pc-foot">
            <button type="button" onClick={onClose} className="wl-btn-secondary" disabled={submitting}>
              {warning ? 'Close' : 'Cancel'}
            </button>
            <button type="submit" disabled={!canSubmit} className="wl-btn-primary">
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  )
}

// One half of the source toggle. Selected = dark, like every segmented control.
function SourceOption({
  label,
  hint,
  selected,
  onSelect,
}: {
  label: string
  hint: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className="pc-opt">
      <b>{label}</b>
      <small>{hint}</small>
    </button>
  )
}
