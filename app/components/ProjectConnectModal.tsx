'use client'

import { useState } from 'react'
import type { MissingScope } from '@/lib/shopifyScopes'

export type ConnectResult = {
  connection_status: string
  shop: string
  missingScopes: MissingScope[]
  last_verified_at: string
}

// Connect or rotate a project's Shopify credentials. The access token is
// write-only from the client's perspective: we send it once, the server probes
// and stores it encrypted, and it's never read back. On rotation the shop_url
// is prefilled but the token field starts empty.
export function ProjectConnectModal({
  projectId,
  mode,
  initialShopUrl,
  onClose,
  onConnected,
}: {
  projectId: string
  mode: 'connect' | 'rotate'
  initialShopUrl?: string | null
  onClose: () => void
  onConnected: (result: ConnectResult) => void
}) {
  const [shopUrl, setShopUrl] = useState(initialShopUrl ?? '')
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const canSubmit = shopUrl.trim() !== '' && token.trim() !== '' && !submitting

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    setWarning(null)
    try {
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
        shop: data.shop ?? shopUrl.trim(),
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.3)' }} />
      <div className="relative ff-panel w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
            {mode === 'rotate' ? 'Replace access token' : 'Connect Shopify'}
          </span>
        </div>

        <form onSubmit={submit}>
          <div className="p-3.5 space-y-3">
            <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              We verify the credentials against Shopify before saving. The token is encrypted at rest
              and never shown again.
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
                {mode === 'rotate' ? 'New access token' : 'Admin API access token'}
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={mode === 'rotate' ? 'Paste the new token' : 'shpat_…'}
                autoComplete="off"
                autoFocus={mode === 'rotate'}
                className="ff-input"
                required
              />
            </div>

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
              {submitting ? 'Verifying…' : mode === 'rotate' ? 'Replace token' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
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
