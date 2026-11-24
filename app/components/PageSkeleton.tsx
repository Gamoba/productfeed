// Route-level loading skeleton in the page layout every redesigned page uses:
// H1 + lede, then cards. Pages pick the shape closest to what they render, so
// nothing jumps when the real page arrives. No old topbar: the shell already
// draws the real one around this.

function Bar({ w, h = 10, r = 6 }: { w: number | string; h?: number; r?: number }) {
  return <div className="animate-pulse" style={{ width: w, height: h, borderRadius: r, background: 'var(--card-2)' }} />
}

export type SkeletonBlock =
  | { kind: 'stats'; cells?: number }
  | { kind: 'table'; rows?: number }
  | { kind: 'card'; lines?: number }
  | { kind: 'toolbar' }

export function PageSkeleton({ blocks, actions = 1 }: { blocks: SkeletonBlock[]; actions?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-busy="true" aria-label="Loading">
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, padding: '2px 2px 0' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Bar w={200} h={26} />
          <Bar w="min(460px, 70vw)" />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {Array.from({ length: actions }, (_, i) => (
            <Bar key={i} w={110} h={34} r={999} />
          ))}
        </div>
      </div>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  )
}

function Block({ block }: { block: SkeletonBlock }) {
  if (block.kind === 'toolbar') {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <Bar w={240} h={32} r={999} />
        <Bar w={90} h={28} r={999} />
        <Bar w={90} h={28} r={999} />
      </div>
    )
  }
  if (block.kind === 'stats') {
    const n = block.cells ?? 4
    return (
      <section className="card" style={{ flexDirection: 'row', gap: 0 }}>
        {Array.from({ length: n }, (_, i) => (
          <div
            key={i}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: i ? '2px 16px' : '2px 16px 2px 0',
              borderLeft: i ? '1px solid var(--line)' : 0,
            }}
          >
            <Bar w={80} />
            <Bar w={70} h={28} />
            <Bar w={110} />
          </div>
        ))}
      </section>
    )
  }
  if (block.kind === 'table') {
    return (
      <section className="card flush">
        {Array.from({ length: block.rows ?? 6 }, (_, i) => (
          <div
            key={i}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i ? '1px solid var(--line)' : 0 }}
          >
            <Bar w={30} h={30} r={9} />
            <Bar w="30%" />
            <div style={{ flex: 1 }} />
            <Bar w={70} />
            <Bar w={70} />
          </div>
        ))}
      </section>
    )
  }
  return (
    <section className="card" style={{ gap: 12 }}>
      <Bar w={140} h={12} />
      {Array.from({ length: block.lines ?? 4 }, (_, i) => (
        <Bar key={i} w={`${90 - i * 12}%`} />
      ))}
    </section>
  )
}
