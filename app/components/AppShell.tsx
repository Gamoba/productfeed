'use client'

import { usePathname } from 'next/navigation'
import { Sidebar } from './shell/Sidebar'
import { TopBar } from './shell/TopBar'
import { useShell } from './shell/useShell'
import './shell/shell.css'

// Pages that render without the shell.
const NO_SHELL = ['/login', '/auth/invite', '/oauth/consent']

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  if (NO_SHELL.includes(pathname)) return <>{children}</>
  return <Shell pathname={pathname}>{children}</Shell>
}

function Shell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const shell = useShell(pathname)
  return (
    <div className="shell">
      <Sidebar shell={shell} pathname={pathname} />
      <TopBar shell={shell} pathname={pathname} />
      <main className="shell-main">{children}</main>
    </div>
  )
}
