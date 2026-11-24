import './agency/agency.css'

// Route-level skeleton for the Agency dashboard: header, stats and table rows.
function Bar({ w, h = 10 }: { w: number | string; h?: number }) {
  return <div className="animate-pulse" style={{ width: w, height: h, borderRadius: 6, background: 'var(--card-2)' }} />
}

export default function Loading() {
  return (
    <div className="ag">
      <div className="ag-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Bar w={220} h={26} />
          <Bar w={420} />
        </div>
      </div>
      <section className="card flush">
        <div className="ag-stats">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ gap: 8 }}>
              <Bar w={90} />
              <Bar w={60} h={28} />
              <Bar w={120} />
            </div>
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i ? '1px solid var(--line)' : 0 }}>
            <Bar w={30} h={30} />
            <Bar w={180} />
            <div style={{ flex: 1 }} />
            <Bar w={80} />
          </div>
        ))}
      </section>
    </div>
  )
}
