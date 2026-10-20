'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

type Account = {
  customerId: string
  name: string
  currencyCode: string
  timeZone: string
  viaManager: string | null
  managerName: string | null
}

type Props = {
  feedId: string
  hasConnection: boolean
  current: {
    customerId: string | null
    roasActions: string[]
    poasActions: string[]
    feedLabel: string | null
  }
  onDone: () => void
}

const fmtId = (id: string) =>
  id.length === 10 ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id

export function GoogleAdsSetup({ feedId, hasConnection, current, onDone }: Props) {
  const router = useRouter()
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [customerId, setCustomerId] = useState(current.customerId ?? '')
  const [feedLabel, setFeedLabel] = useState(current.feedLabel ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const selected = accounts?.find((a) => a.customerId === customerId) ?? null

  const loadingAccounts = hasConnection && accounts === null && !failed

  useEffect(() => {
    if (!hasConnection) return
    let cancelled = false
    fetch(`/api/google-ads/${feedId}/accounts`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (cancelled) return
        if (ok) setAccounts(j.accounts ?? [])
        else {
          setError(j.error ?? 'Could not load accounts')
          setFailed(true)
        }
      })
      .catch(() => {
        if (cancelled) return
        setError('Could not reach the server')
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [hasConnection, feedId])

  async function save() {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/google-ads/${feedId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: selected.customerId,
          customerName: selected.name,
          currencyCode: selected.currencyCode,
          loginCustomerId: selected.viaManager,
          feedLabel: feedLabel || null,
          roasConversionActions: current.roasActions,
          poasConversionActions: current.poasActions,
          syncNow: true,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error ?? 'Could not save')
        return
      }
      if (json.syncError) setError(`Saved, but the data could not be fetched: ${json.syncError}`)
      onDone()
      router.refresh()
    } catch {
      setError('Could not reach the server')
    } finally {
      setSaving(false)
    }
  }

  // ── Step 1: consent ────────────────────────────────────────────────────────
  if (!hasConnection) {
    return (
      <div className="wl-card" style={{ padding: '40px' }}>
        <div className="max-w-xl space-y-4">
          <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--ink)' }}>
            Connect Google Ads
          </h2>
          <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink-secondary)' }}>
            Authorise access and choose the ad account. We then fetch cost, clicks and
            conversion value per product — and refresh daily.
          </p>
          <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            We only read data. Nothing is ever changed in the Google Ads account.
          </p>
          <a
            href={`/api/google-ads/connect?feedId=${feedId}`}
            className="wl-btn-primary inline-block"
          >
            Connect Google Ads →
          </a>
        </div>
      </div>
    )
  }

  // ── Step 2: which account ──────────────────────────────────────────────────
  return (
    <div className="wl-card" style={{ padding: '28px 32px' }}>
      <div className="max-w-2xl space-y-5">
        <div className="space-y-1">
          <h2 style={{ fontSize: '20px', fontWeight: 500, color: 'var(--ink)' }}>
            Choose ad account
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            The connection is authorised. One choice left.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2.5">
            <span
              className="wl-dot shrink-0"
              style={{ background: 'var(--accent-red)', marginTop: '5px' }}
            />
            <p style={{ fontSize: '13px', color: 'var(--ink-secondary)' }}>{error}</p>
          </div>
        )}

        <Field label="Ad account" hint={loadingAccounts ? 'Loading accounts…' : undefined}>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={!accounts}
            style={selectStyle}
          >
            <option value="">Choose account…</option>
            {(accounts ?? []).map((a) => (
              <option key={a.customerId} value={a.customerId}>
                {a.name || fmtId(a.customerId)} · {fmtId(a.customerId)} · {a.currencyCode}
                {a.managerName ? ` (via ${a.managerName})` : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Feed label (optional)"
          hint="Only if the account covers several markets"
        >
          <input
            value={feedLabel}
            onChange={(e) => setFeedLabel(e.target.value)}
            placeholder="e.g. DK — empty means the whole account"
            style={selectStyle}
          />
        </Field>

        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} disabled={!customerId || saving} className="wl-btn-primary">
            {saving ? 'Fetching data…' : 'Save and fetch data'}
          </button>
          <a href={`/api/google-ads/connect?feedId=${feedId}`} className="wl-btn-secondary">
            Reconnect
          </a>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--ink-muted)', lineHeight: 1.5 }}>
          We fetch 90 days and store every conversion action. Afterwards you choose at the
          top of the page which action counts as revenue and which is gross profit — there
          you can see how much each one reports.
        </p>
      </div>
    </div>
  )
}

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: '10px',
  border: '1px solid var(--hairline)',
  background: 'var(--bg-base)',
  color: 'var(--ink)',
  fontSize: '13px',
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className="wl-eyebrow">{label}</span>
        {hint && <span style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  )
}
