'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { layout } from '@/lib/design-tokens'

// ── Nav items ──────────────────────────────────────────────────────────────

// Per-feed nav rendered when a feedId is in the URL. Hrefs are built relative
// to /feed/[feedId]/ at render time.
const FEED_NAV = [
  { label: 'Overview', href: '', icon: 'rss' },
  { label: 'Products', href: 'products', icon: 'box' },
  { label: 'Mapping', href: 'mapping', icon: 'sliders' },
  { label: 'Filters', href: 'filters', icon: 'filter' },
  { label: 'AI Titles', href: 'optimize', icon: 'sparkles' },
  // `exact` because /google-ads/labels is a sibling nav item, not a sub-page of
  // this one — without it prefix matching would light both up at once.
  { label: 'Ads Performance', href: 'google-ads', icon: 'chart', exact: true },
  { label: 'Campaigns', href: 'google-ads/campaigns', icon: 'megaphone' },
  { label: 'Custom labels', href: 'google-ads/labels', icon: 'layers' },
  { label: 'Wasted spend', href: 'google-ads/waste', icon: 'trend-down' },
  { label: 'Preview', href: 'preview', icon: 'eye' },
  { label: 'Settings', href: 'settings', icon: 'settings' },
] as const

const TOP_NAV = [
  { label: 'Projects', href: '/', icon: 'grid' },
] as const

// `exact` is required for index-style items whose href is a PREFIX of their
// siblings — e.g. the feed Overview at /feed/[id], which would otherwise light
// up on every /feed/[id]/* sub-page via the startsWith match below.
function active(pathname: string, href: string, exact = false) {
  if (exact) return pathname === href
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(href + '/')
}

// Extracts the feedId from /feed/[feedId][/...]
function feedIdFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/feed\/([^/]+)/)
  return m ? m[1] : null
}

// ── Icons ──────────────────────────────────────────────────────────────────

const svg = (cls: string, children: React.ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={cls}
  >
    {children}
  </svg>
)

function NavIcon({ name }: { name: string }) {
  const cls = 'w-[14px] h-[14px] shrink-0'
  switch (name) {
    case 'grid':
      return svg(cls, <>
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
      </>)
    case 'box':
      return svg(cls, <>
        <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
        <polyline points="3.27,6.96 12,12.01 20.73,6.96"/>
        <line x1="12" y1="22.08" x2="12" y2="12"/>
      </>)
    case 'sliders':
      return svg(cls, <>
        <line x1="4" y1="21" x2="4" y2="14"/>
        <line x1="4" y1="6" x2="4" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="12"/>
        <line x1="12" y1="4" x2="12" y2="3"/>
        <line x1="20" y1="21" x2="20" y2="16"/>
        <line x1="20" y1="8" x2="20" y2="3"/>
        <line x1="1" y1="14" x2="7" y2="14"/>
        <line x1="9" y1="4" x2="15" y2="4"/>
        <line x1="17" y1="16" x2="23" y2="16"/>
      </>)
    case 'filter':
      return svg(cls, <>
        <polygon points="22,3 2,3 10,12.46 10,19 14,21 14,12.46"/>
      </>)
    case 'eye':
      return svg(cls, <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
        <circle cx="12" cy="12" r="3"/>
      </>)
    case 'rss':
      return svg(cls, <>
        <path d="M4 11a9 9 0 019 9"/>
        <path d="M4 4a16 16 0 0116 16"/>
        <circle cx="5" cy="19" r="1" fill="currentColor" stroke="none"/>
      </>)
    case 'sparkles':
      return svg(cls, <>
        <path d="M12 3l1.9 4.8L18.7 9.7 13.9 11.6 12 16.4 10.1 11.6 5.3 9.7 10.1 7.8z"/>
        <path d="M19 14l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>
      </>)
    case 'layers':
      return svg(cls, <>
        <path d="M12 3l9 5-9 5-9-5 9-5z"/>
        <path d="M3 13l9 5 9-5"/>
      </>)
    case 'chart':
      return svg(cls, <>
        <path d="M3 3v18h18"/>
        <path d="M7 15l3.5-4 3 3L20 7"/>
      </>)
    case 'megaphone':
      return svg(cls, <>
        <path d="M3 11v2a1 1 0 001 1h2l5 4V6L6 10H4a1 1 0 00-1 1z"/>
        <path d="M16 8.5a4 4 0 010 7"/>
        <path d="M19 6a8 8 0 010 12"/>
      </>)
    case 'trend-down':
      return svg(cls, <>
        <polyline points="3,7 9,13 13,9 21,17"/>
        <polyline points="21,11 21,17 15,17"/>
      </>)
    case 'settings':
      return svg(cls, <>
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
      </>)
    default:
      return null
  }
}

function LogOutIcon() {
  return svg('w-[14px] h-[14px] shrink-0', <>
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
    <polyline points="16,17 21,12 16,7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </>)
}

function LogoIcon() {
  return svg('w-3.5 h-3.5 text-white', <>
    <path d="M4 11a9 9 0 019 9"/>
    <path d="M4 4a16 16 0 0116 16"/>
    <circle cx="5" cy="19" r="1" fill="currentColor" stroke="none"/>
  </>)
}

// ── Sidebar ────────────────────────────────────────────────────────────────

type FeedSummary = { id: string; name: string; project_id: string | null }

export function Sidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const [userEmail, setUserEmail] = useState<string>('')
  // Keyed by feed so we can clear the label on feed change by DERIVING it
  // (below) rather than calling setState synchronously inside the effect.
  const [marketData, setMarketData] = useState<{ feedId: string; label: string } | null>(null)
  const [feeds, setFeeds] = useState<FeedSummary[]>([])

  const activeFeedId = feedIdFromPath(pathname)
  const activeFeed = feeds.find((f) => f.id === activeFeedId) ?? null
  const marketLabel = marketData && marketData.feedId === activeFeedId ? marketData.label : ''

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? '')
    })
    fetch('/api/feeds')
      .then((r) => r.json())
      .then((data: { feeds?: FeedSummary[] }) => {
        setFeeds(data.feeds ?? [])
      })
      .catch(() => {})
  }, [])

  // Refetch market label whenever the active feed changes — settings are now
  // per-feed, so the badge only shows when we're inside a feed. State is only
  // set asynchronously (in the fetch callbacks); the no-feed/feed-switch clear
  // is handled by deriving marketLabel above, not by a synchronous setState.
  useEffect(() => {
    if (!activeFeedId) return
    let cancelled = false
    fetch(`/api/settings?feedId=${encodeURIComponent(activeFeedId)}`)
      .then((r) => r.json())
      .then((data: { settings?: { selected_country?: string | null; currency?: string | null } | null }) => {
        if (cancelled) return
        const s = data.settings
        const label = s ? [s.selected_country, s.currency].filter(Boolean).join(' · ') : ''
        setMarketData({ feedId: activeFeedId, label })
      })
      .catch(() => {
        if (!cancelled) setMarketData({ feedId: activeFeedId, label: '' })
      })
    return () => {
      cancelled = true
    }
  }, [activeFeedId])

  async function handleSignOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const navLink = (href: string, icon: string, label: string, exact = false) => {
    const isActive = active(pathname, href, exact)
    return (
      <Link
        key={href}
        href={href}
        className={`ff-nav-item${isActive ? ' ff-nav-item-active' : ''} flex items-center gap-2.5 px-3 py-2`}
        style={{
          fontSize: '13px',
          fontWeight: isActive ? 500 : 400,
          borderRadius: '9px',
          background: isActive ? 'var(--accent-purple)' : 'transparent',
          color: isActive ? 'var(--sidebar-text-active)' : 'var(--sidebar-text)',
        }}
      >
        <NavIcon name={icon} />
        <span>{label}</span>
      </Link>
    )
  }

  // Per-feed nav appears only when we're inside /feed/[feedId]/...
  const feedNavSection = activeFeedId ? (
    <>
      {activeFeed?.project_id &&
        navLink(`/project/${activeFeed.project_id}`, 'back', '← Back to project')}
      <div
        className="mt-3 mb-1 px-3"
        style={{
          fontSize: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.6px',
          color: 'rgba(255,255,255,0.3)',
        }}
      >
        {activeFeed?.name ?? 'Feed'}
      </div>
      {FEED_NAV.map((item) => {
        const fullHref = item.href
          ? `/feed/${activeFeedId}/${item.href}`
          : `/feed/${activeFeedId}`
        // Overview (empty href) is the feed root and a prefix of every sibling,
        // so it must match exactly; the rest keep prefix matching (e.g. AI Titles
        // stays active inside a bucket editor).
        return navLink(fullHref, item.icon, item.label, item.href === '' || 'exact' in item)
      })}
    </>
  ) : null

  return (
    <aside
      className="flex-none flex flex-col h-full"
      style={{
        width: layout.sidebarWidth,
        background: 'var(--sidebar-bg)',
        borderRight: '1px solid var(--sidebar-border)',
      }}
    >
      {/* Logo */}
      <div
        className="px-4 py-4 shrink-0 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--sidebar-border)' }}
      >
        <div
          className="w-6 h-6 flex items-center justify-center shrink-0"
          style={{ background: 'var(--accent-purple)', borderRadius: '7px' }}
        >
          <LogoIcon />
        </div>
        <span
          style={{
            color: 'var(--sidebar-text-active)',
            fontSize: '14px',
            fontWeight: 500,
            letterSpacing: '-0.01em',
          }}
        >
          FeedFlow
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {TOP_NAV.map((item) => navLink(item.href, item.icon, item.label))}
        {feedNavSection}
      </nav>

      {/* Footer */}
      <div
        className="px-3 py-3 shrink-0 space-y-2"
        style={{ borderTop: '1px solid var(--sidebar-border)' }}
      >
        {marketLabel && (
          <div
            className="inline-flex px-2 py-0.5"
            style={{
              background: 'rgba(124, 92, 252, 0.22)',
              color: '#ffffff',
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              letterSpacing: '0.4px',
              borderRadius: '5px',
            }}
          >
            {marketLabel}
          </div>
        )}
        {userEmail && (
          <div
            className="truncate"
            style={{
              color: 'var(--sidebar-text)',
              fontSize: '11px',
            }}
          >
            {userEmail}
          </div>
        )}
        <button
          onClick={handleSignOut}
          className="ff-nav-item w-full flex items-center gap-2.5 px-2 py-1.5"
          style={{
            fontSize: '12px',
            color: 'var(--sidebar-text)',
            borderRadius: '7px',
          }}
        >
          <LogOutIcon />
          Log out
        </button>
      </div>
    </aside>
  )
}
