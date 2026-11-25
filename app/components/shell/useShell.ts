'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShellData } from '@/app/api/shell/route'
import { levelFromPath, type Level } from './nav'

export type Shell = {
  data: ShellData | null
  level: Level
  account: ShellData['accounts'][number] | null
  project: ShellData['projects'][number] | null
  feed: ShellData['feeds'][number] | null
  projectFeeds: ShellData['feeds']
}

// Loads /api/shell and resolves the current level's account, shop and feed.
//
// Fetched once and kept: refetching it on every click cost ~0.5 s of server
// work per navigation. It is refreshed when
//   - it is older than SHELL_MAX_AGE_MS (on navigation or when the tab regains
//     focus), so statuses and the "Needs attention" list stay current;
//   - the page is for a shop or feed it doesn't know yet (just created);
//   - something calls refreshShell() after changing what it shows (renaming or
//     deleting a shop or feed, a feed's market, a decided Claude change).
// The previous data stays on screen while a request runs, so nothing flickers.
const SHELL_MAX_AGE_MS = 60_000
const SHELL_REFRESH_EVENT = 'feedflow:shell-refresh'

/** Ask the shell (sidebar, top bar) to reload its data now. */
export function refreshShell(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHELL_REFRESH_EVENT))
}

export function useShell(pathname: string): Shell {
  const [data, setData] = useState<ShellData | null>(null)
  const seq = useRef(0)
  const loadedAt = useRef(0)

  const load = useCallback(() => {
    const mine = ++seq.current
    loadedAt.current = Date.now()
    fetch('/api/shell')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ShellData | null) => {
        if (d && mine === seq.current) setData(d)
      })
      .catch(() => {
        loadedAt.current = 0
      })
  }, [])

  useEffect(() => {
    const stale = Date.now() - loadedAt.current > SHELL_MAX_AGE_MS
    const lvl = levelFromPath(pathname)
    const unknown =
      !!data &&
      ((lvl.kind === 'feed' && !data.feeds.some((f) => f.id === lvl.feedId)) ||
        (lvl.kind === 'shop' && !data.projects.some((p) => p.id === lvl.projectId)))
    if (stale || unknown) load()
  }, [pathname, load, data])

  useEffect(() => {
    const onRefresh = () => load()
    const onFocus = () => {
      if (Date.now() - loadedAt.current > SHELL_MAX_AGE_MS) load()
    }
    window.addEventListener(SHELL_REFRESH_EVENT, onRefresh)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener(SHELL_REFRESH_EVENT, onRefresh)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const level = levelFromPath(pathname)
  const feed =
    level.kind === 'feed' ? (data?.feeds.find((f) => f.id === level.feedId) ?? null) : null
  const projectId =
    level.kind === 'shop' ? level.projectId : level.kind === 'feed' ? feed?.projectId : undefined
  const project = projectId ? (data?.projects.find((p) => p.id === projectId) ?? null) : null
  const account =
    (project && data?.accounts.find((a) => a.id === project.accountId)) ?? data?.accounts[0] ?? null
  const projectFeeds = project ? (data?.feeds.filter((f) => f.projectId === project.id) ?? []) : []

  return { data, level, account, project, feed, projectFeeds }
}
