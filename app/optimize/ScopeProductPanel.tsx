'use client'

// Reference panel on the Scope page: shows ONE product's full data (all standard
// fields + metafields, human-named via getBucketProductDetail) so the user can see
// what they're filtering against. Swappable by title/vendor search. Read-only.

import { useEffect, useRef, useState } from 'react'
import { searchFeedProducts, getBucketProductDetail, getBucketMembership } from './actions'

type Field = { token: string; label: string; value: string }
type Detail = { product_ref: string; current_title: string; fields: Field[] }
type SearchHit = { product_ref: string; title: string; vendor: string | null; image_url: string | null }

export function ScopeProductPanel({ feedId, bucketId }: { feedId: string; bucketId: string }) {
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const [selectedRef, setSelectedRef] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  // Default to the bucket's first member so the panel isn't empty on entry.
  useEffect(() => {
    let cancelled = false
    getBucketMembership(feedId, bucketId).then((r) => {
      if (cancelled) return
      if ('data' in r && r.data[0]) setSelectedRef((cur) => cur ?? r.data[0])
    })
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId])

  // Load the selected product's full data. (All setState lives inside the async
  // IIFE — not the effect body — to avoid a synchronous-setState-in-effect.)
  useEffect(() => {
    if (!selectedRef) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const r = await getBucketProductDetail(feedId, bucketId, selectedRef)
      if (cancelled) return
      if ('data' in r) setDetail(r.data)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [feedId, bucketId, selectedRef])

  // Debounced title/vendor search (same action the manual-add picker uses). All
  // setState runs inside the timeout callback (not the effect body).
  useEffect(() => {
    const q = search.trim()
    let cancelled = false
    const t = setTimeout(async () => {
      if (!q) {
        setResults([])
        setSearching(false)
        return
      }
      setSearching(true)
      const r = await searchFeedProducts(feedId, q)
      if (cancelled) return
      if ('data' in r) setResults(r.data)
      setSearching(false)
    }, q ? 300 : 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [search, feedId])

  // Close the results dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function pick(ref: string) {
    setSelectedRef(ref)
    setSearch('')
    setResults([])
    setOpen(false)
  }

  return (
    <div className="ff-panel" style={{ position: 'sticky', top: '12px', overflow: 'visible' }}>
      <div className="ff-panel-header" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}>
        Example product
      </div>
      <div className="p-3.5 space-y-2.5">
        <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
          The data you can filter on. Search for a title to see another product.
        </p>

        <div ref={boxRef} style={{ position: 'relative' }}>
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            placeholder="Search products by title or vendor…"
            className="ff-input w-full"
          />
          {open && (searching || results.length > 0) && (
            <div
              className="ff-panel"
              style={{ position: 'absolute', zIndex: 50, top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: '260px', overflowY: 'auto', padding: '4px' }}
            >
              {searching && <p style={{ fontSize: '11px', color: 'var(--ink-muted)', padding: '4px 6px' }}>Searching…</p>}
              {results.map((p) => (
                <button
                  key={p.product_ref}
                  type="button"
                  onClick={() => pick(p.product_ref)}
                  className="flex items-center gap-2 w-full text-left px-1.5 py-1 rounded transition-colors hover:bg-[var(--bg-surface)]"
                  style={{ fontSize: '11px' }}
                >
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.image_url} alt="" loading="lazy" className="w-7 h-7 object-cover shrink-0" style={{ borderRadius: '4px', border: '1px solid var(--hairline)' }} />
                  ) : (
                    <div className="w-7 h-7 shrink-0" style={{ background: 'var(--bg-surface)', borderRadius: '4px' }} />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block truncate" style={{ color: 'var(--ink)' }}>{p.title}</span>
                    {p.vendor && <span className="block truncate" style={{ fontSize: '10px', color: 'var(--ink-muted)' }}>{p.vendor}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-1.5" style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>
            <span
              aria-hidden
              style={{ display: 'inline-block', width: '12px', height: '12px', border: '2px solid var(--hairline)', borderTopColor: 'var(--accent-ink)', borderRadius: '50%', animation: 'ff-spin 0.6s linear infinite' }}
            />{' '}
            Loading…
          </div>
        ) : detail ? (
          // Every row is STACKED — label on top (small, muted), value below — so the
          // two can never overlap and long values wrap cleanly, regardless of width.
          <dl className="space-y-2.5">
            {[{ token: '__title__', label: 'Title', value: detail.current_title || '—' }, ...detail.fields].map((f) => (
              <div key={f.token}>
                <dt style={{ fontSize: '10px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--ink-muted)' }}>
                  {f.label}
                </dt>
                <dd style={{ fontSize: '12.5px', color: 'var(--ink)', lineHeight: 1.4, wordBreak: 'break-word', marginTop: '1px' }}>
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p style={{ fontSize: '11px', color: 'var(--ink-muted)' }}>Search for a product to see its data.</p>
        )}
      </div>
    </div>
  )
}
