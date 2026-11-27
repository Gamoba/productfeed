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
  const d = shell.data
  return accountNav({
    monitoring: monitoringCount(shell),
    isMcc: d?.isMcc,
    hasUserAccount: d?.hasUserAccount ?? true,
    pendingAccess: d?.pendingAccess,
    isPlatformAdmin: d?.isPlatformAdmin,
    customer: shell.account?.type === 'user',
  })
}

// The same rules as Agency › Monitoring's critical list (lib/agencyMonitoring):
// failing Shopify connections, feeds with errors, stale syncs, failed syncs.
function monitoringCount(shell: Shell): number {
  const d = shell.data
  if (!d) return 0
  let n = d.projects.filter((p) => p.connectionError).length
  for (const f of d.feeds) {
    if (f.errors > 0) n++
    if (f.staleDays !== null) n++
    if (f.syncFailed) n++
  }
  return n
}

// Billing is the one page an account without a usable plan can open
// (lib/entitlements.ts); everything else in the menu shows as locked.
export const UNLOCKED_WHEN_BLOCKED = '/billing'
export const isLockedLink = (shell: Shell, href: string) => shell.data?.blocked === true && href !== UNLOCKED_WHEN_BLOCKED

export function Sidebar({ shell, pathname }: { shell: Shell; pathname: string }) {
  const { level, project, feed, account } = shell
  const blocked = shell.data?.blocked === true
  const brand = (
    <>
      <span className="shell-brand-mark">
        <Icon name="bolt" size={15} />
      </span>
      Kompara
    </>
  )

  return (
    <aside className="shell-side" aria-label="Main menu">
      {blocked ? (
        <span className="shell-brand">{brand}</span>
      ) : (
        <Link href="/" className="shell-brand">
          {brand}
        </Link>
      )}

      {level.kind === 'account' ? (
        account && <AccountSwitcher shell={shell} />
      ) : (
        <ShopSwitcher shell={shell} />
      )}

      {level.kind === 'shop' && (
        <Link href="/" className="shell-back">
          <Icon name="back" size={13} />
          All shops
        </Link>
      )}
      {level.kind === 'feed' && (
        <>
          <Link href={project ? `/project/${project.id}` : '/'} className="shell-back">
            <Icon name="back" size={13} />
            Back to shop
          </Link>
          <Link href={`/feed/${level.feedId}`} className="shell-feedcard">
            <ChannelIcon channel={feed?.channel} />
            <span className="shell-ctx-text">
              <b>
                {feed?.country && <span className="shell-flag-sm">{flagEmoji(feed.country)} </span>}
                {feed ? channelOf(feed.channel).label : 'Loading feed'}
              </b>
              <small>{feed ? `${feed.name} · you are in this feed` : ''}</small>
            </span>
          </Link>
        </>
      )}

      {blocked && (
        <Link href={UNLOCKED_WHEN_BLOCKED} className="shell-locknote">
          <Icon name="lock" size={14} />
          <span>
            <b>Choose a plan to continue</b>
            <small>The rest of the app unlocks once a plan is active.</small>
          </span>
        </Link>
      )}

      <nav className="shell-nav">
        {navFor(shell).map((entry) =>
          entry.kind === 'group' ? (
            <NavGroupItem key={entry.label} group={entry} pathname={pathname} shell={shell} />
          ) : (
            <NavLinkItem key={entry.href} link={entry} pathname={pathname} locked={isLockedLink(shell, entry.href)} />
          )
        )}
      </nav>

      <div className="shell-side-foot">
        <UserMenu shell={shell} variant="card" />
      </div>
    </aside>
  )
}

function NavLinkItem({ link, pathname, locked }: { link: NavLink; pathname: string; locked?: boolean }) {
  const active = isActive(pathname, link)
  if (locked) {
    return (
      <span className="shell-navlink shell-navlink-locked" aria-disabled="true" title="Choose a plan to unlock">
        <Icon name={link.icon} size={15} />
        <span>{link.label}</span>
        <Icon name="lock" size={12} className="shell-lock" />
      </span>
    )
  }
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

function NavGroupItem({ group, pathname, shell }: { group: NavGroup; pathname: string; shell: Shell }) {
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
            <NavLinkItem key={i.href} link={i} pathname={pathname} locked={isLockedLink(shell, i.href)} />
          ))}
        </div>
      )}
    </div>
  )
}

const ACCOUNT_TYPE_LABEL = { mcc: 'Agency', user: 'Customer' } as const

// The account the user is working in (lib/currentAccount.ts). With more than
// one account it opens a list to switch; the whole app then shows that one.
function AccountSwitcher({ shell }: { shell: Shell }) {
  const { account, data } = shell
  const accounts = data?.accounts ?? []
  const [switching, setSwitching] = useState<string | null>(null)
  if (!account) return null
  const label = (a: { name: string; type: 'mcc' | 'user'; role: keyof typeof ROLE_LABEL }) => (
    <span className="shell-ctx-text">
      <b>{a.name}</b>
      <small>
        {ACCOUNT_TYPE_LABEL[a.type]} · {ROLE_LABEL[a.role]}
      </small>
    </span>
  )

  if (accounts.length < 2) {
    return (
      <div className="shell-ctx">
        <span className="shell-avatar shell-avatar-hi">{initials(account.name)}</span>
        {label(account)}
      </div>
    )
  }

  async function choose(id: string, close: () => void) {
    if (id === account?.id) return close()
    setSwitching(id)
    const res = await fetch('/api/accounts/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: id }),
    }).catch(() => null)
    if (!res?.ok) {
      setSwitching(null)
      return
    }
    // A full load: every page, the menu and the shell start over in the new account.
    window.location.assign('/')
  }

  return (
    <Popover
      label="Switch account"
      className="shell-shopsel-wrap"
      triggerClassName="shell-shopsel"
      trigger={
        <>
          <span className="shell-avatar shell-avatar-hi">{initials(account.name)}</span>
          {label(account)}
          <Icon name="chevron-down" size={14} className="shell-muted" />
        </>
      }
    >
      {(close) =>
        accounts.map((a) => {
          const current = a.id === account.id
          return (
            <button
              key={a.id}
              type="button"
              role="menuitem"
              className="shell-menu-item shell-menu-shop"
              aria-current={current ? 'true' : undefined}
              disabled={switching !== null}
              onClick={() => void choose(a.id, close)}
            >
              <span className="shell-avatar shell-avatar-hi shell-avatar-sm">{initials(a.name)}</span>
              {switching === a.id ? (
                <span className="shell-ctx-text">
                  <b>{a.name}</b>
                  <small>Switching…</small>
                </span>
              ) : (
                label(a)
              )}
              {current && <Icon name="check" size={14} />}
            </button>
          )
        })
      }
    </Popover>
  )
}

function ShopSwitcher({ shell }: { shell: Shell }) {
  const router = useRouter()
  const { project, data } = shell
  const projects = data?.projects ?? []
  const feedCount = (id: string) => data?.feeds.filter((f) => f.projectId === id).length ?? 0

  return (
    <Popover
      label="Switch shop"
      className="shell-shopsel-wrap"
      triggerClassName="shell-shopsel"
      trigger={
        <>
          <span className="shell-avatar shell-avatar-hi">{project ? initials(project.name) : ''}</span>
          <span className="shell-ctx-text">
            <small>Shop</small>
            <b>{project?.name ?? 'Loading'}</b>
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
                    {[p.shopUrl, n ? `${n} ${n === 1 ? 'feed' : 'feeds'}` : 'no feeds yet']
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
                {current && <Icon name="check" size={14} />}
              </button>
            )
          })}
          <Link href="/" className="shell-menu-item shell-menu-foot" onClick={close}>
            All shops
          </Link>
        </>
      )}
    </Popover>
  )
}
