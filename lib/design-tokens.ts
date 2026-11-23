// FeedFlow design tokens (Design B + Kobolt), for TypeScript call sites.
//
// The source of truth is the :root block in app/globals.css. These are
// references to those CSS variables, not copies of the values, so a token
// changed there changes here too. See .claude/skills/feedflow-design.

export const colors = {
  canvas: 'var(--canvas)',
  canvas2: 'var(--canvas-2)',
  canvasLine: 'var(--canvas-line)',
  onCanvas: 'var(--on-canvas)',
  onCanvasMuted: 'var(--on-canvas-muted)',
  card: 'var(--card)',
  card2: 'var(--card-2)',
  cardFg: 'var(--card-fg)',
  muted: 'var(--muted)',
  line: 'var(--line)',
  tint: 'var(--tint)',
  tintFg: 'var(--tint-fg)',
  hi: 'var(--hi)',
  hiFg: 'var(--hi-fg)',
  hiMuted: 'var(--hi-muted)',
  accentInk: 'var(--accent-ink)',
  dark: 'var(--dark)',
  darkFg: 'var(--dark-fg)',
  good: 'var(--good)',
  goodBg: 'var(--good-bg)',
  warn: 'var(--warn)',
  warnBg: 'var(--warn-bg)',
  bad: 'var(--bad)',
  badBg: 'var(--bad-bg)',
} as const

// Channel icon colours: only for the small 22px channel square.
export const channelColors = {
  google: 'var(--ch-google)',
  meta: 'var(--ch-meta)',
  daisycon: 'var(--ch-daisycon)',
  microsoft: 'var(--ch-microsoft)',
  klaviyo: 'var(--ch-klaviyo)',
  pricerunner: 'var(--ch-pricerunner)',
} as const

export const radius = {
  lg: 'var(--r-lg)', // cards
  md: 'var(--r-md)', // inner boxes
  sm: 'var(--r-sm)',
  pill: '999px', // buttons, pills, chips, segments
} as const

export const layout = {
  sidebarWidth: 'var(--sidebar-w)',
  appMaxWidth: 'var(--app-max)',
  // Below this width the sidebar is hidden and a top pill nav is shown.
  mobileBreakpoint: 820,
} as const

export const typography = {
  font: 'var(--font)',
  code: 'var(--code)', // code/XML and API tokens only
} as const
