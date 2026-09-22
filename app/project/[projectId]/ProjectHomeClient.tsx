'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { FeedListClient } from '@/app/dashboard/FeedListClient'
import {
  ProjectConnectModal,
  projectStatusBadge,
  type ConnectResult,
} from '@/app/components/ProjectConnectModal'
import type { MissingScope } from '@/lib/shopifyScopes'

export function ProjectHomeClient({
  projectId,
  projectName,
  shopUrl: initialShopUrl,
  connectionStatus: initialStatus,
  lastVerifiedAt: initialVerifiedAt,
}: {
  projectId: string
  projectName: string
  shopUrl: string | null
  connectionStatus: string
  lastVerifiedAt: string | null
}) {
  const [shopUrl, setShopUrl] = useState(initialShopUrl)
  const [status, setStatus] = useState(initialStatus)
  const [lastVerifiedAt, setLastVerifiedAt] = useState(initialVerifiedAt)
  const [connectOpen, setConnectOpen] = useState(false)
  const [missing, setMissing] = useState<MissingScope[]>([])

  const connected = status === 'connected'
  const badge = projectStatusBadge(status)

  // Scopes are read live rather than stored (see GET on the connect route), so
  // the warning survives a reload instead of only appearing in the seconds
  // after connecting. Advisory: any failure leaves the list empty and silent.
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    fetch(`/api/projects/${projectId}/connect`)
      .then((r) => r.json())
      .then((data: { missingScopes?: MissingScope[] }) => {
        if (!cancelled) setMissing(data.missingScopes ?? [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId, connected])

  function handleConnected(result: ConnectResult) {
    setStatus(result.connection_status)
    setLastVerifiedAt(result.last_verified_at)
    setShopUrl(result.shop)
    setMissing(result.missingScopes)
  }

  const statusDot =
    status === 'connected' ? 'var(--accent-green)' : status === 'error' ? 'var(--accent-red)' : 'var(--accent-amber)'

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <main className="max-w-5xl mx-auto px-6 py-10 space-y-8">
        {/* Hero */}
        <header className="space-y-3.5">
          <div className="flex items-center gap-2.5">
            <Link href="/" className="wl-eyebrow" style={{ textDecoration: 'none' }}>
              Projects
            </Link>
            <span className="wl-eyebrow">/</span>
            <span className="wl-pill">
              <span className="wl-dot" style={{ background: statusDot }} />
              {badge.label}
            </span>
          </div>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-2 min-w-0">
              <h1
                className="truncate"
                style={{ fontSize: '34px', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--ink)' }}
              >
                {projectName}
              </h1>
              <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink-secondary)' }}>
                {shopUrl ? (
                  <span className="ff-mono">{shopUrl}</span>
                ) : (
                  'Connect this project to a Shopify store to start building feeds.'
                )}
              </p>
            </div>
            <button onClick={() => setConnectOpen(true)} className="wl-btn-secondary shrink-0">
              {connected ? 'Replace token' : 'Connect Shopify'}
            </button>
          </div>
        </header>

        {/* Connection panel */}
        <div className="wl-card">
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--hairline)' }}>
            <span style={{ fontSize: '15px', fontWeight: 500, color: 'var(--ink)' }}>Shopify connection</span>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <ConnInfo label="Status" value={badge.label} />
              <ConnInfo label="Shop URL" value={shopUrl ?? '—'} mono />
              <ConnInfo
                label="Last verified"
                value={
                  lastVerifiedAt
                    ? new Date(lastVerifiedAt).toLocaleString('en-US', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '—'
                }
              />
            </div>

            {!connected && (
              <ConnNotice>
                Connect this project to Shopify before creating feeds — markets and product sync need a
                verified access token.
              </ConnNotice>
            )}

            {connected &&
              missing.map((s) => (
                <ConnNotice key={s.handle}>
                  {s.required ? 'Connected, but missing the required scope ' : 'Connected, but missing the '}
                  <strong>{s.handle}</strong> scope. {s.impact}
                </ConnNotice>
              ))}
          </div>
        </div>

        {/* Feeds for this project */}
        <FeedListClient projectId={projectId} connected={connected} />
      </main>

      {connectOpen && (
        <ProjectConnectModal
          projectId={projectId}
          mode={connected ? 'rotate' : 'connect'}
          initialShopUrl={shopUrl}
          onClose={() => setConnectOpen(false)}
          onConnected={handleConnected}
        />
      )}
    </div>
  )
}

// Calm inline notice — an amber dot does the colour work, no filled box.
function ConnNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-3 flex items-start gap-2.5"
      style={{ padding: '10px 12px', border: '1px solid var(--hairline)', borderRadius: '10px' }}
    >
      <span className="wl-dot shrink-0" style={{ background: 'var(--accent-amber)', marginTop: '5px' }} />
      <p style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--ink-secondary)' }}>{children}</p>
    </div>
  )
}

function ConnInfo({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div
      className="px-3.5 py-2.5"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--hairline)',
        borderRadius: '10px',
      }}
    >
      <p className="wl-eyebrow">{label}</p>
      <p
        className={`mt-1 truncate${mono ? ' ff-mono' : ''}`}
        style={{ fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}
      >
        {value}
      </p>
    </div>
  )
}
