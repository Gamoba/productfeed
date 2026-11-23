// Shell icons: inline SVG, 24px viewBox, stroke 1.7, round caps, currentColor.

export type IconName =
  | 'bolt' | 'overview' | 'box' | 'setup' | 'mapping' | 'filter' | 'titles' | 'tag'
  | 'eye' | 'chart' | 'megaphone' | 'drop' | 'settings' | 'feeds' | 'shops'
  | 'chevron' | 'chevron-down' | 'back' | 'logout' | 'check' | 'menu' | 'search'
  | 'hash' | 'link' | 'image' | 'price' | 'truck' | 'text'

const PATHS: Record<IconName, React.ReactNode> = {
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
  overview: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  setup: (
    <>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </>
  ),
  mapping: (
    <>
      <path d="M4 7h6a4 4 0 0 1 4 4v6" />
      <path d="m11 14 3 3 3-3" />
      <circle cx="4" cy="7" r="1.5" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" />,
  titles: <path d="M4 6h16M4 12h10M4 18h7M17 15l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z" />,
  tag: (
    <>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  chart: <path d="M3 3v18h18M7 15l4-4 3 3 6-7" />,
  megaphone: <path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM16 8.5a4 4 0 0 1 0 7M19 6a8 8 0 0 1 0 12" />,
  drop: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  feeds: (
    <>
      <rect x="3" y="4" width="18" height="4" rx="1.5" />
      <rect x="3" y="10" width="18" height="4" rx="1.5" />
      <rect x="3" y="16" width="18" height="4" rx="1.5" />
    </>
  ),
  shops: (
    <>
      <path d="M4 9 5.5 4h13L20 9M4 9h16v11H4V9z" />
      <path d="M9 20v-5h6v5" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  logout: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  check: <path d="m5 12 5 5L20 7" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  hash: <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m21 16-5-5-8 9" />
    </>
  ),
  price: <path d="M12 3v18M16.5 7.5C16 6 14.3 5 12 5c-2.8 0-4.5 1.4-4.5 3.3 0 4.4 9 2.4 9 7 0 2-1.9 3.7-4.5 3.7-2.4 0-4.2-1.1-4.7-2.8" />,
  truck: (
    <>
      <path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" />
      <circle cx="7" cy="17.5" r="1.8" />
      <circle cx="17" cy="17.5" r="1.8" />
    </>
  ),
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
}

export function Icon({ name, size = 15, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name]}
    </svg>
  )
}
