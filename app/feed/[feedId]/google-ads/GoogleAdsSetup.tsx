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
          setError(j.error ?? 'Kunne ikke hente konti')
          setFailed(true)
        }
      })
      .catch(() => {
        if (cancelled) return
        setError('Kunne ikke få kontakt til serveren')
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
        setError(json.error ?? 'Kunne ikke gemme')
        return
      }
      if (json.syncError) setError(`Gemt, men tallene kunne ikke hentes: ${json.syncError}`)
      onDone()
      router.refresh()
    } catch {
      setError('Kunne ikke få kontakt til serveren')
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
            Kobl Google Ads
          </h2>
          <p style={{ fontSize: '15px', lineHeight: 1.6, color: 'var(--ink-secondary)' }}>
            Giv adgang, og vælg annoncekontoen. Derefter henter vi forbrug, klik og
            konverteringsværdi pr. vare og opdaterer dem dagligt.
          </p>
          <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            Vi læser kun data. Der bliver aldrig ændret noget i Google Ads-kontoen.
          </p>
          <a
            href={`/api/google-ads/connect?feedId=${feedId}`}
            className="wl-btn-primary inline-block"
          >
            Kobl Google Ads →
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
            Vælg annoncekonto
          </h2>
          <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>
            Forbindelsen er godkendt. Der er ét valg tilbage.
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

        <Field label="Annoncekonto" hint={loadingAccounts ? 'Henter konti…' : undefined}>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={!accounts}
            style={selectStyle}
          >
            <option value="">Vælg konto…</option>
            {(accounts ?? []).map((a) => (
              <option key={a.customerId} value={a.customerId}>
                {a.name || fmtId(a.customerId)} · {fmtId(a.customerId)} · {a.currencyCode}
                {a.managerName ? ` (via ${a.managerName})` : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Feed label (valgfri)"
          hint="Kun hvis kontoen dækker flere markeder"
        >
          <input
            value={feedLabel}
            onChange={(e) => setFeedLabel(e.target.value)}
            placeholder="fx DK — tomt betyder hele kontoen"
            style={selectStyle}
          />
        </Field>

        <div className="flex items-center gap-3 pt-1">
          <button onClick={save} disabled={!customerId || saving} className="wl-btn-primary">
            {saving ? 'Henter tal…' : 'Gem og hent tal'}
          </button>
          <a href={`/api/google-ads/connect?feedId=${feedId}`} className="wl-btn-secondary">
            Kobl igen
          </a>
        </div>

        <p style={{ fontSize: '12px', color: 'var(--ink-muted)', lineHeight: 1.5 }}>
          Vi henter 90 dage og gemmer alle konverteringshandlinger. Bagefter vælger du øverst
          på siden, hvilken handling der tæller som omsætning, og hvilken der er bruttoprofit —
          der kan du se, hvor meget hver af dem rapporterer.
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
