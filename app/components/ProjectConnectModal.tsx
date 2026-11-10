'use client'

import { useState } from 'react'
import type { MissingScope } from '@/lib/shopifyScopes'

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
          body: JSON.stringify({ feed_url: feedUrl.trim() }),
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
          'Connected, but the token is missing: ' +
            result.missingScopes.map((s) => `${s.handle} — ${s.impact}`).join(' ')
        )
        onConnected(result)
      } else {
        onConnected(result)
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke forbinde')
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
          ? 'Replace access token'
          : 'Switch to Shopify'

  const submitLabel = submitting
    ? source === 'feed_url'
      ? 'Checking feed…'
      : 'Verifying…'
    : source === 'feed_url'
      ? rotating
        ? 'Save feed URL'
        : 'Connect feed'
      : rotating
        ? 'Replace token'
        : 'Connect'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.3)' }} />
      <div className="relative ff-panel w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}>{title}</span>
        </div>

        <form onSubmit={submit}>
          <div className="p-3.5 space-y-3">
            <div>
              <label className="ff-label block mb-1.5">Source</label>
              <div
                role="radiogroup"
                aria-label="Product source"
                className="grid grid-cols-2 gap-1 p-1"
                style={{ border: '1px solid var(--hairline)', borderRadius: '10px' }}
              >
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
                <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                  We verify the credentials against Shopify before saving. The token is encrypted at
                  rest and never shown again.
                </p>

                <div>
                  <label className="ff-label block mb-1.5">Shop URL</label>
                  <input
                    type="text"
                    value={shopUrl}
                    onChange={(e) => setShopUrl(e.target.value)}
                    placeholder="your-store.myshopify.com"
                    autoFocus={mode === 'connect'}
                    className="ff-input"
                    required
                  />
                </div>

                <div>
                  <label className="ff-label block mb-1.5">
                    {rotating ? 'New access token' : 'Admin API access token'}
                  </label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={rotating ? 'Paste the new token' : 'shpat_…'}
                    autoComplete="off"
                    autoFocus={rotating}
                    className="ff-input"
                    required
                  />
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
                  A public product feed — for example the Google Shopping feed a site on Umbraco
                  exports. We download it once to check it contains products before saving, and
                  again every time the feed is synced.
                </p>

                <div>
                  <label className="ff-label block mb-1.5">Feed URL</label>
                  <input
                    type="url"
                    value={feedUrl}
                    onChange={(e) => setFeedUrl(e.target.value)}
                    placeholder="https://example.com/google-feed.xml"
                    autoFocus
                    className="ff-input"
                    required
                  />
                </div>
              </>
            )}

            {switching && (
              <div
                className="p-2.5"
                style={{
                  background: 'var(--color-badge-warning-bg)',
                  border: '1px solid var(--color-badge-warning-text)',
                  borderRadius: '4px',
                }}
              >
                <p style={{ fontSize: '11px', color: 'var(--color-badge-warning-text)' }}>
                  {source === 'feed_url'
                    ? 'This replaces the Shopify connection — the stored access token is deleted. Existing feeds get their products from the feed URL at their next sync.'
                    : 'This replaces the feed URL. Existing feeds get their products from Shopify at their next sync.'}
                </p>
              </div>
            )}

            {error && (
              <div
                className="p-2.5"
                style={{
                  background: 'var(--color-badge-danger-bg)',
                  border: '1px solid var(--color-badge-danger-text)',
                  borderRadius: '4px',
                }}
              >
                <p style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{error}</p>
              </div>
            )}

            {warning && (
              <div
                className="p-2.5"
                style={{
                  background: 'var(--color-badge-warning-bg)',
                  border: '1px solid var(--color-badge-warning-text)',
                  borderRadius: '4px',
                }}
              >
                <p style={{ fontSize: '11px', color: 'var(--color-badge-warning-text)' }}>{warning}</p>
              </div>
            )}
          </div>

          <div
            className="px-3.5 py-3 flex items-center justify-end gap-2"
            style={{ borderTop: '1px solid var(--color-border-tertiary)' }}
          >
            <button type="button" onClick={onClose} className="ff-btn-secondary" disabled={submitting}>
              {warning ? 'Close' : 'Cancel'}
            </button>
            <button type="submit" disabled={!canSubmit} className="ff-btn-primary">
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// One half of the source toggle. Selected = quiet surface fill + ink text; the
// rest stays neutral, so colour isn't spent on a mode switch.
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
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="text-left px-3 py-2 transition-colors"
      style={{
        borderRadius: '8px',
        border: `1px solid ${selected ? 'var(--hairline)' : 'transparent'}`,
        background: selected ? 'var(--bg-surface)' : 'transparent',
        cursor: 'pointer',
      }}
    >
      <span
        className="block"
        style={{ fontSize: '12px', fontWeight: 500, color: selected ? 'var(--ink)' : 'var(--ink-secondary)' }}
      >
        {label}
      </span>
      <span className="block" style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
        {hint}
      </span>
    </button>
  )
}

// Shared status → badge mapping for projects.
export function projectStatusBadge(status: string): { className: string; label: string } {
  switch (status) {
    case 'connected':
      return { className: 'ff-badge ff-badge-success', label: 'Connected' }
    case 'error':
      return { className: 'ff-badge ff-badge-danger', label: 'Error' }
    default:
      return { className: 'ff-badge ff-badge-neutral', label: 'Not connected' }
  }
}
