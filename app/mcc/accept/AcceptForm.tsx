'use client'

import { useState } from 'react'
import { acceptMccAction } from './actions'

export function AcceptForm({ token }: { token: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="iv-form">
      {error && <p className="note warn">{error}</p>}
      <button
        type="button"
        className="wl-btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          const r = await acceptMccAction(token)
          if (r.error) {
            setError(r.error)
            setBusy(false)
            return
          }
          window.location.assign('/agency/companies')
        }}
      >
        {busy ? 'Setting up…' : 'Set up the agency'}
      </button>
    </div>
  )
}
