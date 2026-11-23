'use client'

import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Icon } from './icons'
import { Popover } from './Popover'
import { initials, ROLE_LABEL } from './nav'
import type { Shell } from './useShell'

// The user card (sidebar foot) and the avatar (top bar on mobile) open the same
// menu: who you are, which account you're in, and sign out.
export function UserMenu({ shell, variant }: { shell: Shell; variant: 'card' | 'avatar' }) {
  const router = useRouter()
  const user = shell.data?.user
  const account = shell.account
  const name = user?.name || user?.email || ''
  const sub = account ? `${account.name} · ${ROLE_LABEL[account.role]}` : ''

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const avatar = <span className="shell-avatar">{name ? initials(name) : ''}</span>

  return (
    <Popover
      label="Brugermenu"
      align={variant === 'card' ? 'left' : 'right'}
      placement={variant === 'card' ? 'above' : 'below'}
      triggerClassName={variant === 'card' ? 'shell-usercard' : 'shell-iconbtn'}
      trigger={
        variant === 'card' ? (
          <>
            {avatar}
            <span className="shell-usercard-text">
              <b>{name}</b>
              <small>{sub}</small>
            </span>
          </>
        ) : (
          avatar
        )
      }
    >
      {(close) => (
        <>
          <div className="shell-menu-head">
            <b>{name}</b>
            {user?.email && user.email !== name && <small>{user.email}</small>}
            {sub && <small>{sub}</small>}
          </div>
          <button
            type="button"
            role="menuitem"
            className="shell-menu-item"
            onClick={() => {
              close()
              void signOut()
            }}
          >
            <Icon name="logout" size={14} />
            Log ud
          </button>
        </>
      )}
    </Popover>
  )
}
