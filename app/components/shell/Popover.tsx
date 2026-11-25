'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// A button that opens a small menu. Closes on outside click, Escape, and when
// an item inside is chosen (items call `close`). The menu renders in a portal
// on <body>, placed from the trigger, so a sticky sidebar or animated cards
// further down the page can never paint over it.
export function Popover({
  label,
  trigger,
  children,
  align = 'left',
  placement = 'below',
  triggerClassName,
  className,
}: {
  label: string
  trigger: React.ReactNode
  children: (close: () => void) => React.ReactNode
  align?: 'left' | 'right'
  placement?: 'below' | 'above'
  triggerClassName?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<React.CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const r = root.current?.getBoundingClientRect()
      if (!r) return
      const vw = document.documentElement.clientWidth
      const vh = window.innerHeight
      setPos({
        ...(placement === 'below' ? { top: r.bottom + 6 } : { bottom: vh - r.top + 6 }),
        ...(align === 'left' ? { left: Math.max(8, r.left) } : { right: Math.max(8, vw - r.right) }),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align, placement])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (root.current?.contains(t) || menu.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className={`shell-pop ${className ?? ''}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={triggerClassName}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menu} role="menu" className="shell-menu shell-menu-portal" style={pos}>
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </div>
  )
}
