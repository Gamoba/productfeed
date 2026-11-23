'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Icon } from './icons'
import { Popover } from './Popover'
import {
  accountNav,
  feedNav,
  flagEmoji,
  groupIsActive,
  initials,
  isActive,
  ROLE_LABEL,
  shopNav,
  type NavEntry,
  type NavGroup,
  type NavLink,
} from './nav'
import { UserMenu } from './UserMenu'
import { ChannelIcon } from '../ChannelIcon'
import { channelOf } from '@/lib/channels'
import type { Shell } from './useShell'

export function navFor(shell: Shell): NavEntry[] {
  const { level } = shell
  if (level.kind === 'feed') return feedNav(level.feedId)
  if (level.kind === 'shop') return shopNav(level.projectId)
  return accountNav()
}

export function Sidebar({ shell, pathname }: { shell: Shell; pathname: string }) {
  const { level, project, feed, account } = shell

  return (
    <aside className="shell-side" aria-label="Hovedmenu">
      <Link href="/" className="shell-brand">
        <span className="shell-brand-mark">
          <Icon name="bolt" size={15} />
        </span>
        FeedFlow
      </Link>

      {level.kind === 'account' ? (
        account && (
          <div className="shell-ctx">
            <span className="shell-avatar shell-avatar-hi">{initials(account.name)}</span>
            <span className="shell-ctx-text">
              <b>{account.name}</b>
              <small>Konto · {ROLE_LABEL[account.role]}</small>
            </span>
          </div>
        )
      ) : (
        <ShopSwitcher shell={shell} />
      )}

      {level.kind === 'shop' && (
        <Link href="/" className="shell-back">
          <Icon name="back" size={13} />
          Alle shops
        </Link>
      )}
      {level.kind === 'feed' && (
        <>
          <Link href={project ? `/project/${project.id}` : '/'} className="shell-back">
            <Icon name="back" size={13} />
            Tilbage til shop
          </Link>
          <Link href={`/feed/${level.feedId}`} className="shell-feedcard">
            <ChannelIcon channel={feed?.channel} />
            <span className="shell-ctx-text">
              <b>
                {feed?.country && <span className="shell-flag-sm">{flagEmoji(feed.country)} </span>}
                {feed ? channelOf(feed.channel).label : 'Indlæser feed'}
              </b>
              <small>{feed ? `${feed.name} · du er inde på dette feed` : ''}</small>
            </span>
          </Link>
        </>
      )}

      <nav className="shell-nav">
        {navFor(shell).map((entry) =>
          entry.kind === 'group' ? (
            <NavGroupItem key={entry.label} group={entry} pathname={pathname} />
          ) : (
            <NavLinkItem key={entry.href} link={entry} pathname={pathname} />
          )
        )}
      </nav>

      <div className="shell-side-foot">
        <UserMenu shell={shell} variant="card" />
      </div>
    </aside>
  )
}

function NavLinkItem({ link, pathname }: { link: NavLink; pathname: string }) {
  const active = isActive(pathname, link)
  return (
    <Link
      href={link.href}
      className="shell-navlink"
      aria-current={active ? 'page' : undefined}
    >
      <Icon name={link.icon} size={15} />
      <span>{link.label}</span>
      {!!link.badge && <span className="shell-badge">{link.badge}</span>}
    </Link>
  )
}

function NavGroupItem({ group, pathname }: { group: NavGroup; pathname: string }) {
  const active = groupIsActive(pathname, group)
  // null = follow the route (open while one of its pages is active); a click
  // pins it open or shut.
  const [pinned, setPinned] = useState<boolean | null>(null)
  const open = pinned ?? active
  const badgeSum = group.items.reduce((n, i) => n + (i.badge ?? 0), 0)

  return (
    <div className="shell-navgroup" data-open={open}>
      <button
        type="button"
        className="shell-navlink"
        aria-expanded={open}
        onClick={() => setPinned(!open)}
      >
        <Icon name={group.icon} size={15} />
        <span>{group.label}</span>
        {!open && badgeSum > 0 && <span className="shell-badge">{badgeSum}</span>}
        <Icon name="chevron" size={13} className="shell-chev" />
      </button>
      {open && (
        <div className="shell-navsub">
          {group.items.map((i) => (
            <NavLinkItem key={i.href} link={i} pathname={pathname} />
          ))}
        </div>
      )}
    </div>
  )
}

function ShopSwitcher({ shell }: { shell: Shell }) {
  const router = useRouter()
  const { project, data } = shell
  const projects = data?.projects ?? []
  const feedCount = (id: string) => data?.feeds.filter((f) => f.projectId === id).length ?? 0

  return (
    <Popover
      label="Skift shop"
      className="shell-shopsel-wrap"
      triggerClassName="shell-shopsel"
      trigger={
        <>
          <span className="shell-avatar shell-avatar-hi">{project ? initials(project.name) : ''}</span>
          <span className="shell-ctx-text">
            <small>Shop</small>
            <b>{project?.name ?? 'Indlæser'}</b>
          </span>
          <Icon name="chevron-down" size={14} className="shell-muted" />
        </>
      }
    >
      {(close) => (
        <>
          {projects.map((p) => {
            const n = feedCount(p.id)
            const current = p.id === project?.id
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="shell-menu-item shell-menu-shop"
                aria-current={current ? 'true' : undefined}
                onClick={() => {
                  close()
                  router.push(`/project/${p.id}`)
                }}
              >
                <span className="shell-avatar shell-avatar-hi shell-avatar-sm">{initials(p.name)}</span>
                <span className="shell-ctx-text">
                  <b>{p.name}</b>
                  <small>
                    {[p.shopUrl, n ? `${n} ${n === 1 ? 'feed' : 'feeds'}` : 'ingen feeds endnu']
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
                {current && <Icon name="check" size={14} />}
              </button>
            )
          })}
          <Link href="/" className="shell-menu-item shell-menu-foot" onClick={close}>
            Alle shops
          </Link>
        </>
      )}
    </Popover>
  )
}
