'use client'

import { useEffect, useMemo, useState } from 'react'
import type { PreviewData, PreviewRow } from '@/lib/feedGenerator'

const REQUIRED = new Set(['id', 'title', 'description', 'link', 'image_link', 'price', 'availability'])

// ── Value cell ─────────────────────────────────────────────────────────────

function FieldValue({ value }: { value: string | undefined }) {
  if (value === '__AI__') {
    return <span className="ff-badge ff-badge-accent">AI</span>
  }
  if (!value) {
    return (
      <span style={{ fontSize: '10px', fontStyle: 'italic', color: 'var(--color-text-tertiary)' }}>
        Empty
      </span>
    )
  }
  if (value.startsWith('http')) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="ff-mono break-all hover:underline"
        style={{ fontSize: '11px', color: 'var(--color-accent)' }}
      >
        {value}
      </a>
    )
  }
  return (
    <span
      style={{
        fontSize: '11px',
        color: 'var(--color-text-primary)',
        // Cap long values (e.g. the description) to a readable measure so they
        // wrap at a comfortable line length instead of spanning the whole panel.
        display: 'inline-block',
        maxWidth: '640px',
        wordBreak: 'break-word',
        // Descriptions carry real line breaks (stripHtml keeps paragraph
        // boundaries). Render them, rather than collapsing the feed's actual
        // content into one running block.
        whiteSpace: 'pre-wrap',
      }}
    >
      {value}
    </span>
  )
}

// ── Product view ───────────────────────────────────────────────────────────

function ProductView({ rows, googleFields }: { rows: PreviewRow[]; googleFields: string[] }) {
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(rows[0]?.productId ?? null)

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return !q ? rows : rows.filter((r) => r.title.toLowerCase().includes(q))
  }, [rows, search])

  const selected = rows.find((r) => r.productId === selectedId) ?? null
  const unmappedRequired = [...REQUIRED].filter((f) => !googleFields.includes(f))

  return (
    <div className="flex gap-3 h-[calc(100vh-160px)]">
      {/* Product list */}
      <div className="w-64 flex-none flex flex-col ff-panel">
        <div
          className="p-2 shrink-0"
          style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}
        >
          <input
            type="search"
            placeholder="Search product…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ff-input"
          />
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <p className="p-3" style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              No products
            </p>
          ) : (
            filtered.map((row) => (
              <button
                key={row.productId}
                onClick={() => setSelectedId(row.productId)}
                className="w-full text-left px-3 py-2 transition-colors"
                style={{
                  borderBottom: '1px solid var(--color-border-tertiary)',
                  background: selectedId === row.productId ? 'var(--color-badge-accent-bg)' : 'transparent',
                }}
              >
                <div
                  className="truncate"
                  style={{
                    fontSize: '11px',
                    fontWeight: selectedId === row.productId ? 500 : 400,
                    color: selectedId === row.productId ? 'var(--color-badge-accent-text)' : 'var(--color-text-primary)',
                  }}
                >
                  {row.title || '(untitled)'}
                </div>
                <div
                  className="ff-mono truncate mt-0.5"
                  style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}
                >
                  {row.productId}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Field values */}
      <div className="flex-1 ff-panel flex flex-col">
        {!selected ? (
          <div
            className="flex-1 flex items-center justify-center"
            style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}
          >
            Select a product on the left
          </div>
        ) : (
          <div className="overflow-y-auto flex-1">
            {unmappedRequired.length > 0 && (
              <div
                className="m-3 p-2.5"
                style={{
                  background: 'var(--color-badge-warning-bg)',
                  border: '1px solid var(--color-badge-warning-text)',
                  borderRadius: '4px',
                }}
              >
                <p
                  className="mb-1"
                  style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-badge-warning-text)' }}
                >
                  Required fields not mapped:
                </p>
                <div className="flex flex-wrap gap-1">
                  {unmappedRequired.map((f) => (
                    <span key={f} className="ff-badge ff-badge-warning ff-mono">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <table className="ff-table">
              <thead>
                <tr>
                  <th style={{ width: '180px' }}>Google field</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {googleFields.map((field) => {
                  const value = selected.fields[field]
                  const missing = REQUIRED.has(field) && (!value || value === '')
                  return (
                    <tr key={field} style={missing ? { background: 'var(--color-badge-danger-bg)' } : undefined}>
                      <td className="whitespace-nowrap">
                        <span className="ff-mono" style={{ fontSize: '11px', color: 'var(--color-text-primary)' }}>{field}</span>
                        {REQUIRED.has(field) && (
                          <span
                            className="ml-1"
                            style={{ color: 'var(--color-badge-danger-text)', fontSize: '11px', fontWeight: 700 }}
                          >
                            *
                          </span>
                        )}
                      </td>
                      <td>
                        {missing ? (
                          <span style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-badge-danger-text)' }}>
                            Missing
                          </span>
                        ) : (
                          <FieldValue value={value} />
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Field view ─────────────────────────────────────────────────────────────

function FieldView({ rows, googleFields }: { rows: PreviewRow[]; googleFields: string[] }) {
  const preview = rows.slice(0, 10)

  return (
    <div className="space-y-3">
      {googleFields.map((field) => {
        const isRequired = REQUIRED.has(field)
        const emptyCount = rows.filter((r) => !r.fields[field] || r.fields[field] === '').length

        return (
          <div key={field} className="ff-panel">
            <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '11px' }}>
              <div className="flex items-center gap-1.5">
                <span className="ff-mono" style={{ fontSize: '11px', fontWeight: 500, color: 'var(--color-text-primary)' }}>
                  {field}
                </span>
                {isRequired && (
                  <span style={{ color: 'var(--color-badge-danger-text)', fontSize: '11px', fontWeight: 700 }}>*</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {emptyCount > 0 && (
                  <span className="ff-badge ff-badge-warning">{emptyCount} empty</span>
                )}
                <span style={{ fontSize: '10px', color: 'var(--color-text-tertiary)', textTransform: 'none', letterSpacing: 0 }}>
                  first {Math.min(preview.length, 10)} entries
                </span>
              </div>
            </div>
            <table className="ff-table">
              <tbody>
                {preview.map((row) => (
                  <tr key={row.productId}>
                    <td style={{ width: '260px' }}>
                      <div className="truncate" style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
                        {row.title || '(untitled)'}
                      </div>
                    </td>
                    <td>
                      <FieldValue value={row.fields[field]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export function PreviewClient({
  feedId,
  feedName,
  data: initialData,
}: {
  feedId: string
  feedName: string
  data: PreviewData
}) {
  const [tab, setTab] = useState<'product' | 'field'>('product')
  // LAG 1 ships ~20 rows from the server. After mount we upgrade to a fuller
  // 100-row sample so the user can inspect more products and the topbar count
  // reflects an accurate total. `upgrading` drives a subtle dim until the
  // fuller dataset arrives.
  const [data, setData] = useState<PreviewData>(initialData)
  const [upgrading, setUpgrading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/preview?feedId=${encodeURIComponent(feedId)}&limit=100`)
      .then((r) => (r.ok ? r.json() : null))
      .then((full: PreviewData | null) => {
        if (cancelled || !full) return
        setData(full)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setUpgrading(false)
      })
    return () => {
      cancelled = true
    }
  }, [feedId])

  return (
    <div className="min-h-screen">
      <header className="ff-topbar">
        <div className="flex items-center gap-3">
          <h1 className="ff-topbar-title">{feedName} · Preview</h1>
          <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
            {data.rows.length}
            {data.feedMode === 'variant' ? ' variants' : ' products'}
            {data.totalProducts !== data.rows.length
              ? ` (${data.rows.length} of ${data.totalProducts})`
              : ''}
            {' · '}
            {data.googleFields.length} fields
          </span>
        </div>
        <div
          className="inline-flex overflow-hidden"
          style={{ border: '1px solid var(--color-border-secondary)', borderRadius: '4px' }}
        >
          {(['product', 'field'] as const).map((t, i) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: '4px 10px',
                fontSize: '11px',
                fontWeight: 500,
                borderLeft: i > 0 ? '1px solid var(--color-border-secondary)' : 'none',
                background: tab === t ? '#6c5ce7' : 'transparent',
                color: tab === t ? '#ffffff' : 'var(--color-text-secondary)',
              }}
            >
              {t === 'product' ? 'Product view' : 'Field view'}
            </button>
          ))}
        </div>
      </header>

      <main
        className="px-4 py-4"
        style={{ opacity: upgrading ? 0.85 : 1, transition: 'opacity 150ms ease' }}
      >
        {data.rows.length === 0 ? (
          <div
            className="ff-panel py-12 text-center"
            style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}
          >
            No products match the current filters.
          </div>
        ) : tab === 'product' ? (
          <ProductView rows={data.rows} googleFields={data.googleFields} />
        ) : (
          <FieldView rows={data.rows} googleFields={data.googleFields} />
        )}
      </main>
    </div>
  )
}
