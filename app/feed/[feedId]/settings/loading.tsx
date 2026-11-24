import './settings.css'

// Route-level skeleton for Settings: header plus the four cards.
function Bar({ w, h = 10 }: { w: number | string; h?: number }) {
  return <div className="animate-pulse" style={{ width: w, height: h, borderRadius: 6, background: 'var(--card-2)' }} />
}

function CardSkeleton({ rows }: { rows: number }) {
  return (
    <section className="card se-card" style={{ gap: 14 }}>
      <Bar w={120} h={12} />
      <Bar w="70%" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
          <Bar w={110} />
          <Bar w={160} h={28} />
        </div>
      ))}
    </section>
  )
}

export default function Loading() {
  return (
    <div className="se">
      <div className="se-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Bar w={140} h={26} />
          <Bar w={420} />
        </div>
      </div>
      <div className="se-grid">
        <CardSkeleton rows={4} />
        <CardSkeleton rows={3} />
        <CardSkeleton rows={2} />
        <CardSkeleton rows={2} />
      </div>
    </div>
  )
}
