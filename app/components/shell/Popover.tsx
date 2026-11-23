'use client'

import { useEffect, useRef, useState } from 'react'

// A button that opens a small menu. Closes on outside click, Escape, and when
// an item inside is chosen (items call `close`).
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

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
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
      {open && (
        <div role="menu" className={`shell-menu shell-menu-${align} shell-menu-${placement}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
