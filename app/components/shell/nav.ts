// Navigation model for the app shell: which level a URL is on, and the menu for
// each level. Levels follow docs/redesign/GUIDELINES.md §2:
//
//   account  — "/" and anything not inside a shop or feed (the shop list)
//   shop     — /project/[projectId]
//   feed     — /feed/[feedId]/...
//
// Only pages that exist are listed. Postponed areas (CSS, Master fields, agency
// sub-pages, shop tools and account pages) are added when they are built.

import type { IconName } from './icons'

export type Level =
  | { kind: 'account' }
  | { kind: 'shop'; projectId: string }
  | { kind: 'feed'; feedId: string }

export function levelFromPath(pathname: string): Level {
  const feed = pathname.match(/^\/feed\/([^/]+)/)
  if (feed) return { kind: 'feed', feedId: feed[1] }
  const project = pathname.match(/^\/project\/([^/]+)/)
  if (project) return { kind: 'shop', projectId: project[1] }
  return { kind: 'account' }
}

export type NavLink = {
  kind: 'link'
  label: string
  href: string
  icon: IconName
  // Match the URL exactly instead of as a prefix. Needed when the href is a
  // prefix of a sibling (feed Overview, Performance).
  exact?: boolean
  badge?: number
}

export type NavGroup = {
  kind: 'group'
  label: string
  icon: IconName
  items: NavLink[]
}

export type NavEntry = NavLink | NavGroup

export function isActive(pathname: string, link: NavLink): boolean {
  if (link.exact) return pathname === link.href
  return pathname === link.href || pathname.startsWith(link.href + '/')
}

export function groupIsActive(pathname: string, group: NavGroup): boolean {
  return group.items.some((i) => isActive(pathname, i))
}

// Feed pages by sub-path, in menu order. `label` is also the breadcrumb.
const FEED_PAGES = {
  overview: { path: '', label: 'Overview', icon: 'overview' },
  products: { path: 'products', label: 'Products', icon: 'box' },
  mapping: { path: 'mapping', label: 'Mapping', icon: 'mapping' },
  filters: { path: 'filters', label: 'Inkludér / ekskludér', icon: 'filter' },
  titles: { path: 'optimize', label: 'AI Titles', icon: 'titles' },
  labels: { path: 'google-ads/labels', label: 'Labels', icon: 'tag' },
  preview: { path: 'preview', label: 'Preview & eksport', icon: 'eye' },
  performance: { path: 'google-ads', label: 'Performance', icon: 'chart' },
  campaigns: { path: 'google-ads/campaigns', label: 'Campaigns', icon: 'megaphone' },
  waste: { path: 'google-ads/waste', label: 'Wasted spend', icon: 'drop' },
  settings: { path: 'settings', label: 'Settings', icon: 'settings' },
} as const satisfies Record<string, { path: string; label: string; icon: IconName }>

type FeedPageKey = keyof typeof FEED_PAGES

function feedLink(feedId: string, key: FeedPageKey): NavLink {
  const p = FEED_PAGES[key]
  return {
    kind: 'link',
    label: p.label,
    href: p.path ? `/feed/${feedId}/${p.path}` : `/feed/${feedId}`,
    icon: p.icon,
    // Overview and Performance are prefixes of their siblings.
    exact: key === 'overview' || key === 'performance',
  }
}

export function feedNav(feedId: string): NavEntry[] {
  return [
    feedLink(feedId, 'overview'),
    feedLink(feedId, 'products'),
    {
      kind: 'group',
      label: 'Opsætning',
      icon: 'setup',
      items: [
        feedLink(feedId, 'mapping'),
        feedLink(feedId, 'filters'),
        feedLink(feedId, 'titles'),
        feedLink(feedId, 'labels'),
        feedLink(feedId, 'preview'),
      ],
    },
    {
      kind: 'group',
      label: 'Annoncer',
      icon: 'chart',
      items: [
        feedLink(feedId, 'performance'),
        feedLink(feedId, 'campaigns'),
        feedLink(feedId, 'waste'),
      ],
    },
    feedLink(feedId, 'settings'),
  ]
}

export function shopNav(projectId: string): NavEntry[] {
  return [
    { kind: 'link', label: 'Feeds', href: `/project/${projectId}`, icon: 'feeds', exact: true },
    { kind: 'link', label: 'General performance', href: `/project/${projectId}/performance`, icon: 'chart' },
  ]
}

export function accountNav(): NavEntry[] {
  return [
    { kind: 'link', label: 'Agency dashboard', href: '/', icon: 'overview', exact: true },
    { kind: 'link', label: 'Agency users', href: '/agency/users', icon: 'users' },
  ]
}

// Breadcrumb label for the current feed page. Longest matching path wins, so
// /google-ads/labels is "Labels", not "Performance".
export function feedPageLabel(pathname: string, feedId: string): string {
  const rest = pathname.slice(`/feed/${feedId}`.length).replace(/^\//, '')
  let best: { len: number; label: string } = { len: -1, label: FEED_PAGES.overview.label }
  for (const p of Object.values(FEED_PAGES)) {
    if (!p.path) continue
    if ((rest === p.path || rest.startsWith(p.path + '/')) && p.path.length > best.len) {
      best = { len: p.path.length, label: p.label }
    }
  }
  return best.label
}

// The same page on another feed, for the feed switcher.
export function samePageOnFeed(pathname: string, fromFeedId: string, toFeedId: string): string {
  const rest = pathname.slice(`/feed/${fromFeedId}`.length)
  // Sub-pages with their own ids (an AI Titles bucket) don't exist on the other
  // feed; land on the section instead.
  const section = rest.match(/^\/optimize\//) ? '/optimize' : rest
  return `/feed/${toFeedId}${section}`
}

// Country code → flag emoji ("DE" → 🇩🇪). Empty string when unknown.
export function flagEmoji(country: string | null | undefined): string {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return ''
  return String.fromCodePoint(
    ...country.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  )
}

export function initials(name: string): string {
  const words = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  const letters = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

export const ROLE_LABEL: Record<'owner' | 'admin' | 'member', string> = {
  owner: 'Ejer',
  admin: 'Admin',
  member: 'Medlem',
}
