'use client'

import { useEffect, useRef, useState } from 'react'
import type { ShopifyProduct } from '@/lib/shopify'
import type { SyncResult } from '@/lib/sync'
import { ProductsTable } from '../dashboard/ProductsTable'

type Phase = 'loading' | 'empty' | 'syncing' | 'ready' | 'error'

type MetaResponse = {
  total: number
  totalPages: number
  vendors: string[]
  productTypes: string[]
}

type ProductsResponse = {
  products: ShopifyProduct[]
  total: number | null
  page: number
  pageSize: number
  totalPages: number | null
}

const DEFAULT_PAGE_SIZE = 25

export function ProductsClient({
  feedId,
  feedName,
}: {
  feedId: string
  feedName: string
  userEmail: string
}) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [products, setProducts] = useState<ShopifyProduct[]>([])
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  // "namespace.key" → readable metafield definition name, so the per-product
  // metafields table shows "Årgang" rather than the mangled "custom._rgang".
  // Best-effort: stays empty if the lookup fails, falling back to raw keys.
  const [metafieldNames, setMetafieldNames] = useState<Map<string, string>>(new Map())
  const [productsLoading, setProductsLoading] = useState(true)
  const [metaLoading, setMetaLoading] = useState(true)

  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [filterVendor, setFilterVendor] = useState('')
  const [filterProductType, setFilterProductType] = useState('')

  // Cancellation tokens for in-flight fetches. When a newer fetch starts the
  // previous one's response is dropped, otherwise stale results can overwrite
  // fresh ones (typing fast in the search box reproduced this).
  const productsReq = useRef(0)
  const metaReq = useRef(0)

  // Metafield definition names (one cheap, cached per-feed lookup). setState only
  // inside the async callback, per the repo's set-state-in-effect rule.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/metafield-names?feedId=${encodeURIComponent(feedId)}`)
      .then((r) => r.json())
      .then((d: { names?: Record<string, string> }) => {
        if (cancelled) return
        setMetafieldNames(new Map(Object.entries(d.names ?? {})))
      })
      .catch(() => {
        // Non-fatal — the metafields table stays on raw keys.
      })
    return () => {
      cancelled = true
    }
  }, [feedId])

  // Debounce raw input → committed query (300ms).
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 300)
    return () => clearTimeout(t)
  }, [searchInput])

  // Reset to page 1 when the active filters or page size change.
  useEffect(() => {
    setPage(1)
  }, [searchQuery, pageSize, filterVendor, filterProductType])

  // ── LAG 1: products (fast — skips count query) ─────────────────────────────
  function buildQueryParams(extra: Record<string, string> = {}): URLSearchParams {
    const params = new URLSearchParams({
      feedId,
      page: String(page),
      pageSize: String(pageSize),
      ...extra,
    })
    if (searchQuery) params.set('search', searchQuery)
    if (filterVendor) params.set('vendor', filterVendor)
    if (filterProductType) params.set('product_type', filterProductType)
    return params
  }

  async function fetchProducts(opts: { initial?: boolean } = {}) {
    const reqId = ++productsReq.current
    setProductsLoading(true)
    if (opts.initial) setError(null)
    try {
      const params = buildQueryParams({ skipCount: '1' })
      const res = await fetch(`/api/products?${params.toString()}`)
      if (reqId !== productsReq.current) return
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as ProductsResponse
      if (reqId !== productsReq.current) return
      setProducts(json.products)
      // Empty UI only fires on the very first load with no search/filter applied.
      if (
        opts.initial &&
        json.products.length === 0 &&
        !searchQuery &&
        !filterVendor &&
        !filterProductType
      ) {
        setPhase('empty')
      } else {
        setPhase('ready')
      }
    } catch (err) {
      if (reqId !== productsReq.current) return
      setError(err instanceof Error ? err.message : 'Unknown error')
      setPhase('error')
    } finally {
      if (reqId === productsReq.current) setProductsLoading(false)
    }
  }

  // ── LAG 2: meta (count + totalPages + facets) ──────────────────────────────
  async function fetchMeta() {
    const reqId = ++metaReq.current
    setMetaLoading(true)
    try {
      const params = new URLSearchParams({ feedId, pageSize: String(pageSize) })
      if (searchQuery) params.set('search', searchQuery)
      if (filterVendor) params.set('vendor', filterVendor)
      if (filterProductType) params.set('product_type', filterProductType)
      const res = await fetch(`/api/products/meta?${params.toString()}`)
      if (reqId !== metaReq.current) return
      if (!res.ok) return
      const json = (await res.json()) as MetaResponse
      if (reqId !== metaReq.current) return
      setMeta(json)
    } catch {
      // meta failures are non-fatal — keep prior meta (or null) and stay quiet.
    } finally {
      if (reqId === metaReq.current) setMetaLoading(false)
    }
  }

  async function runSync() {
    setPhase('syncing')
    setSyncResult(null)
    setError(null)
    try {
      const res = await fetch(`/api/shopify/sync?feedId=${encodeURIComponent(feedId)}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`)
      }
      const result: SyncResult = await res.json()
      setSyncResult(result)
      setPage(1)
      // Refetch both tiers; phase will be set by fetchProducts based on results.
      await Promise.all([fetchProducts({ initial: true }), fetchMeta()])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
      setPhase('error')
    }
  }

  // Initial load: kick off both tiers in parallel.
  useEffect(() => {
    fetchProducts({ initial: true })
    fetchMeta()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refetch products on page/pageSize/search/filter changes (after first load).
  useEffect(() => {
    if (phase === 'loading' || phase === 'syncing' || phase === 'empty') return
    fetchProducts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize, searchQuery, filterVendor, filterProductType])

  // Refetch meta when filters or search change (page change keeps total stable).
  useEffect(() => {
    if (phase === 'loading' || phase === 'syncing') return
    fetchMeta()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, searchQuery, filterVendor, filterProductType])

  // List dim: cover both the typing-but-not-yet-committed window and the
  // actual fetch. Without the input!==query check the dim only kicks in after
  // the debounce, which feels laggy.
  const isStale =
    productsLoading || searchInput !== searchQuery
  const totalLabel = meta ? `of ${meta.total} products` : 'products'

  const statusLine =
    phase === 'ready'
      ? `${products.length} ${totalLabel}${syncResult ? ` · synced in ${(syncResult.durationMs / 1000).toFixed(1)}s` : ''}`
      : phase === 'loading'
        ? 'Loading…'
        : phase === 'syncing'
          ? 'Syncing…'
          : ''

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <main className="max-w-6xl mx-auto px-6 py-9 space-y-6">
        {/* Hero */}
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div className="space-y-1.5">
            <div className="wl-eyebrow truncate">{feedName}</div>
            <h1 style={{ fontSize: '30px', fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.1, color: 'var(--ink)' }}>
              Products
            </h1>
            {statusLine && <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>{statusLine}</p>}
          </div>
          {(phase === 'ready' || phase === 'empty') && (
            <button onClick={runSync} className="wl-btn-primary shrink-0">
              Sync again
            </button>
          )}
        </header>

        {/* Non-fatal sync warnings. The sync succeeded, but something in the
            data it wrote is degraded — e.g. metaobject references that stayed
            raw Shopify IDs. Amber, not red: nothing is broken, but a feed built
            on this will carry IDs where names belong. */}
        {(syncResult?.warnings ?? []).length > 0 && (
          <div className="wl-card" style={{ padding: '16px' }}>
            {(syncResult?.warnings ?? []).map((w) => (
              <div key={w.code} className="flex items-start gap-2.5">
                <span
                  className="wl-dot shrink-0"
                  style={{ background: 'var(--accent-amber)', marginTop: '5px' }}
                />
                <p style={{ fontSize: '12px', color: 'var(--ink-secondary)', lineHeight: 1.6 }}>
                  {w.message}
                </p>
              </div>
            ))}
          </div>
        )}

        {phase === 'error' && (
          <div className="wl-card" style={{ padding: '16px' }}>
            <div className="flex items-start gap-2.5">
              <span className="wl-dot shrink-0" style={{ background: 'var(--accent-red)', marginTop: '5px' }} />
              <div>
                <p style={{ fontSize: '13px', fontWeight: 500, color: 'var(--ink)' }}>Something went wrong</p>
                <p className="mt-1" style={{ fontSize: '12px', color: 'var(--ink-secondary)' }}>{error}</p>
              </div>
            </div>
            <button
              onClick={() => {
                setPhase('loading')
                fetchProducts({ initial: true })
                fetchMeta()
              }}
              className="wl-btn-secondary mt-3"
            >
              Try again
            </button>
          </div>
        )}

        {phase === 'syncing' && (
          <div className="wl-card py-16 flex flex-col items-center gap-3">
            <div
              className="w-6 h-6 rounded-full animate-spin"
              style={{ border: '2px solid var(--accent-purple)', borderTopColor: 'transparent' }}
            />
            <p style={{ fontSize: '13px', color: 'var(--ink-muted)' }}>Fetching from Shopify and saving…</p>
          </div>
        )}

        {phase === 'empty' && (
          <div className="wl-card py-16 flex flex-col items-center gap-3">
            <p style={{ fontSize: '14px', color: 'var(--ink-secondary)' }}>No products yet</p>
            <button onClick={runSync} className="wl-btn-primary">
              Sync products
            </button>
          </div>
        )}

        {(phase === 'loading' || phase === 'ready') && (
          <>
            {/* Filter row — search + (faded-in) facet dropdowns */}
            <div className="flex gap-2 mb-3 flex-wrap">
              <input
                type="search"
                placeholder="Search title, vendor, handle, tags…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="ff-input"
                style={{ flex: '1 1 240px', minWidth: 0 }}
              />
              <FacetSelect
                value={filterVendor}
                onChange={setFilterVendor}
                options={meta?.vendors ?? []}
                placeholder="All vendors"
                ready={!metaLoading && !!meta}
              />
              <FacetSelect
                value={filterProductType}
                onChange={setFilterProductType}
                options={meta?.productTypes ?? []}
                placeholder="All types"
                ready={!metaLoading && !!meta}
              />
            </div>

            {phase === 'loading' && products.length === 0 ? (
              <RowSkeletons count={20} />
            ) : (
              <ProductsTable
                products={products}
                total={meta?.total ?? products.length}
                page={page}
                pageSize={pageSize}
                totalPages={meta?.totalPages ?? null}
                hasActiveFilter={
                  !!searchQuery || !!filterVendor || !!filterProductType
                }
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
                loading={isStale}
                metafieldNames={metafieldNames}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

// ── Facet dropdown ────────────────────────────────────────────────────────────

// Fades in once the facet list has loaded so it doesn't pop in jarringly.
function FacetSelect({
  value,
  onChange,
  options,
  placeholder,
  ready,
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
  placeholder: string
  ready: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={!ready || options.length === 0}
      className="ff-select"
      style={{
        flex: '0 0 180px',
        opacity: ready ? 1 : 0.5,
        transition: 'opacity 0.2s ease',
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
}

// ── Row skeletons (initial LAG 1 fetch) ──────────────────────────────────────

function RowSkeletons({ count }: { count: number }) {
  return (
    <div className="space-y-1.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="ff-panel">
          <div className="flex items-center gap-3 px-3.5 py-2">
            <div
              className="w-9 h-9 shrink-0 animate-pulse"
              style={{
                background: 'var(--bg-surface)',
                borderRadius: '4px',
              }}
            />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div
                className="h-3 animate-pulse"
                style={{
                  width: '60%',
                  background: 'var(--bg-surface)',
                  borderRadius: '4px',
                }}
              />
              <div
                className="h-2.5 animate-pulse"
                style={{
                  width: '40%',
                  background: 'var(--bg-surface)',
                  borderRadius: '4px',
                }}
              />
            </div>
            <div
              className="h-3 shrink-0 animate-pulse"
              style={{
                width: '64px',
                background: 'var(--bg-surface)',
                borderRadius: '4px',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
