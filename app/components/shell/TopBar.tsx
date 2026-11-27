'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { Icon } from './icons'
import { Popover } from './Popover'
import { accountNav, shopNav, feedPageLabel, flagEmoji, isActive, samePageOnFeed, type NavLink } from './nav'
import { isLockedLink, navFor } from './Sidebar'
import { UserMenu } from './UserMenu'
import { AttentionButton, FeedStatusPill, SearchButton } from './TopTools'
import { ChannelIcon } from '../ChannelIcon'
import { channelOf } from '@/lib/channels'
import type { Shell } from './useShell'

export function TopBar({ shell, pathname }: { shell: Shell; pathname: string }) {
  return (
    <header className="shell-top">
      <Link href="/" className="shell-brand shell-mobile-only">
        <span className="shell-brand-mark">
          <Icon name="bolt" size={15} />
        </span>
        FeedFlow
      </Link>

      <Crumbs shell={shell} pathname={pathname} />

      <div className="shell-top-tools">
        <FeedStatusPill shell={shell} />
        {/* Search and alerts lead into shops and feeds: hidden while locked. */}
        {!shell.data?.blocked && (
          <>
            <SearchButton shell={shell} />
            <AttentionButton shell={shell} />
          </>
        )}
        <span className="shell-mobile-only">
          <UserMenu shell={shell} variant="avatar" />
        </span>
      </div>

      <MobileNav shell={shell} pathname={pathname} />
    </header>
  )
}

function Crumbs({ shell, pathname }: { shell: Shell; pathname: string }) {
  const { level, account, project } = shell

  if (level.kind === 'feed') {
    return (
      <nav className="shell-crumbs" aria-label="Breadcrumbs">
        {project && <Link href={`/project/${project.id}`}>{project.name}</Link>}
        <Sep />
        <FeedSwitcher shell={shell} pathname={pathname} />
        <Sep />
        <b>{feedPageLabel(pathname, level.feedId)}</b>
      </nav>
    )
  }

  if (level.kind === 'shop') {
    return (
      <nav className="shell-crumbs" aria-label="Breadcrumbs">
        {account && <Link href="/">{account.name}</Link>}
        <Sep />
        <Link href={project ? `/project/${project.id}` : '/'}>{project?.name ?? ''}</Link>
        <Sep />
        <b>{shopPageLabel(pathname, level.projectId)}</b>
      </nav>
    )
  }

  return (
    <nav className="shell-crumbs" aria-label="Breadcrumbs">
      {account && <span>{account.name}</span>}
      {account && <Sep />}
      <b>{accountPageLabel(pathname, account?.type === 'user')}</b>
    </nav>
  )
}

// The shop-level page's menu label ("Feeds", "General performance",
// "Connections"), group items included.
function shopPageLabel(pathname: string, projectId: string): string {
  const links = shopNav(projectId).flatMap((e) => (e.kind === 'group' ? e.items : [e]))
  const link = links.find((e) => isActive(pathname, e))
  return link?.label ?? 'Feeds'
}

// The account-level page's menu label ("Agency dashboard", "Agency users").
function accountPageLabel(pathname: string, customer: boolean): string {
  const link = accountNav({ customer, isMcc: true, hasUserAccount: true, isPlatformAdmin: true }).find(
    (e): e is NavLink => e.kind === 'link' && isActive(pathname, e)
  )
  return link?.label ?? (customer ? 'Dashboard' : 'Agency dashboard')
}

function Sep() {
  return <span className="shell-sep" aria-hidden="true">›</span>
}

// The current feed as a pill; opens the shop's other feeds and lands on the
// same page there.
function FeedSwitcher({ shell, pathname }: { shell: Shell; pathname: string }) {
  const router = useRouter()
  const { feed, projectFeeds, level } = shell
  if (level.kind !== 'feed') return null

  return (
    <Popover
      label="Switch feed"
      triggerClassName="shell-feedpill"
      trigger={
        <>
          {feed?.country && <span className="shell-flag-sm">{flagEmoji(feed.country)}</span>}
          <span>{feed ? channelOf(feed.channel).label : 'Feed'}</span>
          {projectFeeds.length > 1 && <Icon name="chevron-down" size={12} />}
        </>
      }
    >
      {(close) =>
        projectFeeds.map((f) => (
          <button
            key={f.id}
            type="button"
            role="menuitem"
            className="shell-menu-item"
            aria-current={f.id === feed?.id ? 'true' : undefined}
            onClick={() => {
              close()
              if (f.id !== level.feedId) router.push(samePageOnFeed(pathname, level.feedId, f.id))
            }}
          >
            <ChannelIcon channel={f.channel} size={20} />
            <span className="shell-grow">
              {f.country && <span className="shell-flag-sm">{flagEmoji(f.country)} </span>}
              {channelOf(f.channel).label}
              <small className="shell-menu-sub">{f.name}</small>
            </span>
            {f.id === feed?.id && <Icon name="check" size={14} />}
          </button>
        ))
      }
    </Popover>
  )
}

// Below 820px the sidebar is hidden; its links become a horizontal pill row.
function MobileNav({ shell, pathname }: { shell: Shell; pathname: string }) {
  const links: NavLink[] = navFor(shell).flatMap((e) => (e.kind === 'group' ? e.items : [e]))
  const row = useRef<HTMLElement>(null)

  // Keep the current page's pill in view; it can sit far right in the row.
  useEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('[aria-current="page"]')
    if (el && row.current) {
      row.current.scrollLeft = el.offsetLeft - row.current.clientWidth / 2 + el.clientWidth / 2
    }
  }, [pathname])

  return (
    <nav ref={row} className="shell-mobnav shell-mobile-only" aria-label="Menu">
      {shell.level.kind === 'feed' && shell.project && (
        <Link href={`/project/${shell.project.id}`}>
          <Icon name="back" size={13} />
          Shop
        </Link>
      )}
      {shell.level.kind === 'shop' && (
        <Link href="/">
          <Icon name="back" size={13} />
          All shops
        </Link>
      )}
      {links.map((l) =>
        isLockedLink(shell, l.href) ? (
          <span key={l.href} className="shell-mobnav-locked" aria-disabled="true" title="Choose a plan to unlock">
            {l.label}
          </span>
        ) : (
          <Link key={l.href} href={l.href} aria-current={isActive(pathname, l) ? 'page' : undefined}>
            {l.label}
          </Link>
        )
      )}
    </nav>
  )
}
