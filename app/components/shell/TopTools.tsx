'use client'

// The top bar's right side: the feed's status pill (feed level), search
// (⌘K / Ctrl+K: jump to a page, shop or feed) and "Needs attention" (what is
// waiting or broken right now). All three read the shell data (/api/shell).

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './icons'
import { Popover } from './Popover'
import { accountNav, feedNav, flagEmoji, shopNav, type NavEntry } from './nav'
import { channelOf } from '@/lib/channels'
import { formatWhen } from '@/lib/formatDa'
import type { Shell } from './useShell'

const TEXT = {
  status: {
    running: 'Feed running',
    errors: (n: number) => (n === 1 ? '1 error in the feed' : `${n} errors in the feed`),
    not_generated: 'Not generated yet',
    stale: (d: number) => `Not synced for ${d} days`,
  },
  search: 'Search',
  searchPlaceholder: 'Search pages, shops and feeds',
  noResults: 'Nothing matches. Try a shop, a country or a page name.',
  groupPages: 'Pages',
  groupFeeds: 'Feeds',
  groupShops: 'Shops',
  attention: 'Needs attention',
  attentionEmpty: 'Nothing needs attention right now.',
  pending: (n: number) => (n === 1 ? '1 change from Claude waits for approval' : `${n} changes from Claude wait for approval`),
  feedErrors: (n: number) => (n === 1 ? '1 error in the feed' : `${n} errors in the feed`),
  stale: (d: number) => `Products not synced for ${d} days`,
}

// ── Status pill ──────────────────────────────────────────────────────────────

export function FeedStatusPill({ shell }: { shell: Shell }) {
  const feed = shell.feed
  if (shell.level.kind !== 'feed' || !feed) return null
  const label =
    feed.status === 'running'
      ? TEXT.status.running
      : feed.status === 'errors'
        ? TEXT.status.errors(feed.errors)
        : feed.status === 'stale'
          ? TEXT.status.stale(feed.staleDays ?? 0)
          : TEXT.status.not_generated
  return (
    <Link href={`/feed/${feed.id}`} className={`shell-status is-${feed.status}`}>
      <span className="shell-status-dot" aria-hidden="true" />
      {label}
    </Link>
  )
}

// ── Search ───────────────────────────────────────────────────────────────────

type Hit = { key: string; group: string; label: string; sub?: string; href: string; icon: IconName }

const flat = (entries: NavEntry[]) => entries.flatMap((e) => (e.kind === 'group' ? e.items : [e]))

export function SearchButton({ shell }: { shell: Shell }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <button type="button" className="shell-iconbtn shell-toolbtn" aria-label={`${TEXT.search} (Ctrl+K)`} title={`${TEXT.search} (⌘K / Ctrl+K)`} onClick={() => setOpen(true)}>
        <Icon name="search" size={16} />
      </button>
      {open && <SearchDialog shell={shell} onClose={() => setOpen(false)} />}
    </>
  )
}

function SearchDialog({ shell, onClose }: { shell: Shell; onClose: () => void }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const all = useMemo<Hit[]>(() => {
    const data = shell.data
    const hits: Hit[] = []
    const level = shell.level
    const pages =
      level.kind === 'feed' ? flat(feedNav(level.feedId)) : level.kind === 'shop' ? flat(shopNav(level.projectId)) : flat(accountNav())
    for (const p of pages) hits.push({ key: `p:${p.href}`, group: TEXT.groupPages, label: p.label, href: p.href, icon: p.icon as IconName })
    const shopName = new Map((data?.projects ?? []).map((p) => [p.id, p.name]))
    for (const f of data?.feeds ?? []) {
      hits.push({
        key: `f:${f.id}`,
        group: TEXT.groupFeeds,
        label: `${f.country ? flagEmoji(f.country) + ' ' : ''}${channelOf(f.channel).label}`,
        sub: `${shopName.get(f.projectId) ?? ''} · ${f.name}`,
        href: `/feed/${f.id}`,
        icon: 'feeds',
      })
    }
    for (const p of data?.projects ?? []) {
      hits.push({ key: `s:${p.id}`, group: TEXT.groupShops, label: p.name, sub: p.shopUrl ?? undefined, href: `/project/${p.id}`, icon: 'building' })
    }
    return hits
  }, [shell.data, shell.level])

  const results = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const list = words.length
      ? all.filter((h) => {
          const text = `${h.label} ${h.sub ?? ''} ${h.group}`.toLowerCase()
          return words.every((w) => text.includes(w))
        })
      : all.filter((h) => h.group === TEXT.groupPages).concat(all.filter((h) => h.group !== TEXT.groupPages).slice(0, 6))
    return list.slice(0, 30)
  }, [q, all])

  function go(h: Hit | undefined) {
    if (!h) return
    onClose()
    router.push(h.href)
  }

  return createPortal(
    <div className="shell-search-overlay" onMouseDown={onClose}>
      <div className="shell-search" role="dialog" aria-modal="true" aria-label={TEXT.search} onMouseDown={(e) => e.stopPropagation()}>
        <label className="shell-search-in">
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={q}
            placeholder={TEXT.searchPlaceholder}
            aria-label={TEXT.searchPlaceholder}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter') go(results[active])
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <ul className="shell-search-list" role="listbox">
          {results.length === 0 && <li className="shell-search-empty">{TEXT.noResults}</li>}
          {results.map((h, i) => (
            <li key={h.key}>
              {(i === 0 || results[i - 1].group !== h.group) && <span className="shell-search-group">{h.group}</span>}
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className="shell-search-hit"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(h)}
              >
                <Icon name={h.icon} size={14} />
                <span className="shell-grow">
                  {h.label}
                  {h.sub && <small>{h.sub}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body
  )
}

// ── Needs attention ──────────────────────────────────────────────────────────

type Item = { key: string; href: string; title: string; sub: string; at?: string }

export function AttentionButton({ shell }: { shell: Shell }) {
  const data = shell.data
  const items = useMemo<Item[]>(() => {
    if (!data) return []
    const shopName = new Map(data.projects.map((p) => [p.id, p.name]))
    const feedLabel = (f: (typeof data.feeds)[number]) =>
      `${f.country ? flagEmoji(f.country) + ' ' : ''}${channelOf(f.channel).label} · ${shopName.get(f.projectId) ?? ''}`
    const out: Item[] = []
    for (const p of data.attention?.pendingChanges ?? []) {
      out.push({ key: `c:${p.projectId}`, href: `/project/${p.projectId}/api`, title: TEXT.pending(p.count), sub: shopName.get(p.projectId) ?? '' })
    }
    for (const f of data.attention?.failures ?? []) {
      const href = f.feedId ? `/feed/${f.feedId}` : f.projectId ? `/project/${f.projectId}/activity` : '/'
      out.push({ key: `x:${f.at}:${f.feedId}`, href, title: f.action, sub: [f.feedLabel, f.message].filter(Boolean).join(' · '), at: f.at })
    }
    for (const f of data.feeds) {
      if (f.status === 'errors') out.push({ key: `e:${f.id}`, href: `/feed/${f.id}`, title: TEXT.feedErrors(f.errors), sub: feedLabel(f) })
      else if (f.status === 'stale') out.push({ key: `s:${f.id}`, href: `/feed/${f.id}/products`, title: TEXT.stale(f.staleDays ?? 0), sub: feedLabel(f) })
    }
    return out
  }, [data])

  return (
    <Popover
      label={`${TEXT.attention}${items.length ? ` (${items.length})` : ''}`}
      align="right"
      triggerClassName="shell-iconbtn shell-toolbtn"
      className="shell-attention"
      trigger={
        <>
          <Icon name="bell" size={16} />
          {items.length > 0 && <span className="shell-badge">{items.length > 99 ? '99+' : items.length}</span>}
        </>
      }
    >
      {(close) => (
        <div className="shell-att">
          <b className="shell-att-h">{TEXT.attention}</b>
          {items.length === 0 ? (
            <p className="shell-att-empty">{TEXT.attentionEmpty}</p>
          ) : (
            items.map((it) => (
              <Link key={it.key} href={it.href} className="shell-att-item" onClick={close}>
                <span className="shell-att-dot" aria-hidden="true" />
                <span className="shell-grow">
                  {it.title}
                  <small>
                    {it.sub}
                    {it.at ? ` · ${formatWhen(it.at)}` : ''}
                  </small>
                </span>
              </Link>
            ))
          )}
        </div>
      )}
    </Popover>
  )
}
