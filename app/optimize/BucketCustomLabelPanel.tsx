'use client'

// Per-bucket Google Shopping custom label, for split-testing title strategies in
// Google Ads. Pick custom_label_0…4 + a value (e.g. "title-test-A"); at feed
// generation every product in this bucket emits <g:custom_label_N>value</g:…>.
// If a feed mapping already sets that same custom_label_N, the mapping WINS — we
// warn here rather than silently lose the bucket value.

import { useEffect, useState } from 'react'
import { getBucketCustomLabel, setBucketCustomLabel } from './actions'

export function BucketCustomLabelPanel({ feedId, bucketId }: { feedId: string; bucketId: string }) {
  const [index, setIndex] = useState<number | null>(null)
  const [value, setValue] = useState('')
  const [conflicts, setConflicts] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getBucketCustomLabel(feedId, bucketId).then((r) => {
      if (cancelled) return
      if ('data' in r) {
        setIndex(r.data.index)
        setValue(r.data.value)
        setConflicts(r.data.conflicts)
      } else setError(r.error)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId])

  async function handleSave() {
    setError(null)
    setSaving(true)
    // None selected or empty value clears the label.
    const r = await setBucketCustomLabel(feedId, bucketId, index, index === null ? null : value)
    if (r.error) setError(r.error)
    else {
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    }
    setSaving(false)
  }

  const conflict = index !== null && conflicts.includes(index)

  // Render immediately on entry (like Include/Exclude/Manual) — don't gate the whole
  // panel on its own data load. The fields show right away and populate with the
  // saved value when it arrives; inputs/Save stay disabled until then so a click
  // can't clear a not-yet-loaded saved label.
  return (
    <div className="ff-panel">
      <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
        Custom label for split testing
      </div>
      <div className="p-3.5 space-y-2">
        {error && <div style={{ fontSize: '11px', color: 'var(--accent-red)' }}>{error}</div>}

        <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
          Give every product in the bucket a custom label in Google Shopping, so you can compare the
          bucket’s results (clicks and sales) with another bucket in Google Ads.
        </p>

        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="ff-label">Label</label>
            <select
              value={index === null ? '' : String(index)}
              onChange={(e) => {
                setIndex(e.target.value === '' ? null : Number(e.target.value))
                setSaved(false)
              }}
              disabled={loading}
              className="ff-select w-44"
            >
              <option value="">None</option>
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  custom_label_{n}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="ff-label">Value</label>
            <input
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                setSaved(false)
              }}
              disabled={loading || index === null}
              placeholder="E.g. title-test-A"
              className="ff-input w-full"
            />
          </div>
          <button onClick={handleSave} disabled={saving || loading} className="ff-btn-primary">
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>

        {conflict && (
          <div className="ff-badge ff-badge-warning" style={{ display: 'inline-block', whiteSpace: 'normal', lineHeight: 1.4 }}>
            ⚠ custom_label_{index} is already set by a mapping in the feed. The mapping wins, so the bucket’s
            value won’t appear in the feed. Choose another label or remove the mapping.
          </div>
        )}
      </div>
    </div>
  )
}
