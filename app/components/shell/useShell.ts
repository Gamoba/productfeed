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
// Refetched on navigation (it is small) so a newly created shop or feed shows
// up in the switchers without a reload. The previous data stays on screen
// while the new request runs, so the menu never flickers empty.
export function useShell(pathname: string): Shell {
  const [data, setData] = useState<ShellData | null>(null)
  const seq = useRef(0)

  const load = useCallback(() => {
    const mine = ++seq.current
    fetch('/api/shell')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ShellData | null) => {
        if (d && mine === seq.current) setData(d)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
  }, [pathname, load])

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
