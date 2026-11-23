'use client'

import Link from 'next/link'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { ShopifyProduct } from '@/lib/shopify'
import type { SyncResult } from '@/lib/sync'
import type { FeedViewItem } from '@/lib/feedGenerator'
import { formatNumber, formatWhen } from '@/lib/formatDa'
import { Icon } from '../components/shell/icons'
import { SyncProgressBar, useFeedSync } from '../components/SyncProgress'
import './products.css'

// Feed › Products (reference: references/feed_products.jpg). Every product the
// shop has, with what the feed makes of it: in or out (and why), the title in
// the feed, and the feed's values next to the shop's metafields.

type ProductsResponse = {
  products: ShopifyProduct[]
  feed?: Record<string, FeedViewItem>
  error?: string
}
type MetaResponse = { total: number; totalPages: number; vendors: string[]; productTypes: string[] }

const PAGE_SIZES = [25, 50, 100, 200] as const

const SORTS = [
  { value: '', label: 'Sortér: Ældste først' },
  { value: 'newest', label: 'Sortér: Nyeste først' },
  { value: 'title_asc', label: 'Sortér: Navn A til Å' },
  { value: 'title_desc', label: 'Sortér: Navn Å til A' },
] as const

// Feed fields shown first in "Værdier i feedet"; the rest follow in mapping order.
const KEY_FIELDS = ['id', 'title', 'price', 'sale_price', 'availability', 'brand', 'gtin', 'mpn', 'product_type', 'google_product_category', 'custom_label_0']

export function ProductsClient({ feedId, lastSynced: initialLastSynced }: { feedId: string; lastSynced: string | null }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(25)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('')
  const [stock, setStock] = useState('')
  const [vendor, setVendor] = useState('')
  const [productType, setProductType] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  const [result, setResult] = useState<{ key: string; products: ShopifyProduct[]; feed: Record<string, FeedViewItem> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [meta, setMeta] = useState<MetaResponse | null>(null)
  const [scopeCounts, setScopeCounts] = useState<{ included: number; excluded: number } | null>(null)
  const [metafieldNames, setMetafieldNames] = useState<Map<string, string>>(new Map())
  const [openId, setOpenId] = useState<string | null>(null)
  const [lastSynced, setLastSynced] = useState(initialLastSynced)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)

  const filterKey = JSON.stringify([search, stock, vendor, productType])
  const listKey = JSON.stringify([filterKey, sort, page, pageSize, reloadKey])
  const loading = result?.key !== listKey
  const hasFilter = !!(search || stock || vendor || productType)

  // Debounce typing into the committed search.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim())
      if (searchInput.trim() !== search) setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput, search])

  // The page of products, with the feed's view of each.
  const req = useRef(0)
  useEffect(() => {
    const mine = ++req.current
    const params = new URLSearchParams({ feedId, page: String(page), pageSize: String(pageSize), skipCount: '1', feedView: '1' })
    if (search) params.set('search', search)
    if (sort) params.set('sort', sort)
    if (stock) params.set('in_stock', stock)
    if (vendor) params.set('vendor', vendor)
    if (productType) params.set('product_type', productType)
    fetch(`/api/products?${params}`)
      .then(async (r) => {
        const d = (await r.json()) as ProductsResponse
        if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`)
        return d
      })
      .then((d) => {
        if (mine !== req.current) return
        setError(null)
        setResult({ key: listKey, products: d.products, feed: d.feed ?? {} })
      })
      .catch((e: unknown) => {
        if (mine !== req.current) return
        setError(e instanceof Error ? e.message : 'Varerne kunne ikke hentes')
        setResult({ key: listKey, products: [], feed: {} })
      })
  }, [feedId, page, pageSize, search, sort, stock, vendor, productType, reloadKey, listKey])

  // Total and filter options, for the pager and selects.
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ feedId, pageSize: String(pageSize) })
    if (search) params.set('search', search)
    if (stock) params.set('in_stock', stock)
    if (vendor) params.set('vendor', vendor)
    if (productType) params.set('product_type', productType)
    fetch(`/api/products/meta?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MetaResponse | null) => {
        if (!cancelled && d) setMeta(d)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [feedId, pageSize, search, stock, vendor, productType, reloadKey])

  // In feed / excluded across the whole shop, and readable metafield names.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/feeds/${encodeURIComponent(feedId)}/counts`)
      .then((r) => r.json())
      .then((d: { included?: number; excluded?: number }) => {
        if (!cancelled) setScopeCounts({ included: d.included ?? 0, excluded: d.excluded ?? 0 })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [feedId, reloadKey])
  useEffect(() => {
    let cancelled = false
    fetch(`/api/metafield-names?feedId=${encodeURIComponent(feedId)}`)
      .then((r) => r.json())
      .then((d: { names?: Record<string, string> }) => {
        if (!cancelled) setMetafieldNames(new Map(Object.entries(d.names ?? {})))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [feedId])

  const sync = useFeedSync(feedId, {
    onFinished: (outcome) => {
      if (!outcome.ok) {
        setError(outcome.error)
        return
      }
      setSyncResult(outcome.result)
      setLastSynced(new Date().toISOString())
      setPage(1)
      setReloadKey((k) => k + 1)
    },
  })

  // Changing a filter starts over at page 1.
  function onFilter<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v)
      setPage(1)
      setOpenId(null)
    }
  }

  const products = result?.products ?? []
  const total = meta?.total ?? null
  const firstShown = (page - 1) * pageSize + 1
  const lastShown = (page - 1) * pageSize + products.length
  const canNext = total == null ? products.length === pageSize : lastShown < total
  const neverSynced = !lastSynced && !sync.running && result && !loading && products.length === 0 && !hasFilter

  return (
    <div className="pr">
      <div className="pr-head">
        <div>
          <h1>Products</h1>
          <p className="pr-lede">
            Alt hvad feedet ved om hver vare. Søg og filtrér listen, og klik på en vare for at folde dens
            felter ud under den.
          </p>
        </div>
        <div className="pr-actions">
          <span className="pr-synced">
            {sync.running ? 'Synkroniserer…' : lastSynced ? `Synket ${formatWhen(lastSynced)}` : 'Aldrig synket'}
          </span>
          <button type="button" className="wl-btn-primary" onClick={() => void sync.start()} disabled={sync.running}>
            Synk igen
          </button>
        </div>
      </div>

      {sync.running && sync.status && <SyncProgressBar status={sync.status} />}
      {(syncResult?.warnings ?? []).map((w) => (
        <p key={w.code} className="note warn">
          {w.message}
        </p>
      ))}
      {error && <p className="note warn">{error}</p>}

      {neverSynced ? (
        <section className="card pr-empty">
          <p>Feedet har ingen varer endnu. Hent dem fra shoppen for at komme i gang.</p>
          <button type="button" className="wl-btn-primary" onClick={() => void sync.start()}>
            Hent varer
          </button>
        </section>
      ) : (
        <section className="card flush pr-card">
          <div className="pr-tools">
            <label className="pr-search">
              <Icon name="search" size={14} />
              <input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Søg på titel, producent, handle eller tags"
                aria-label="Søg i varer"
              />
            </label>
            <select className="ff-select pr-sel" value={sort} onChange={(e) => onFilter(setSort)(e.target.value)} aria-label="Sortering">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select className="ff-select pr-sel" value={stock} onChange={(e) => onFilter(setStock)(e.target.value)} aria-label="Lager">
              <option value="">Lager: Alle</option>
              <option value="true">Lager: På lager</option>
              <option value="false">Lager: Ikke på lager</option>
            </select>
            <select
              className="ff-select pr-sel"
              value={vendor}
              onChange={(e) => onFilter(setVendor)(e.target.value)}
              disabled={!meta?.vendors.length}
              aria-label="Producent"
            >
              <option value="">Producent: Alle</option>
              {(meta?.vendors ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <select
              className="ff-select pr-sel"
              value={productType}
              onChange={(e) => onFilter(setProductType)(e.target.value)}
              disabled={!meta?.productTypes.length}
              aria-label="Varetype"
            >
              <option value="">Type: Alle</option>
              {(meta?.productTypes ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          <p className="pr-summary">
            {scopeCounts ? (
              <>
                <span className="st">{formatNumber(scopeCounts.included)} i feedet</span>
                <span className={scopeCounts.excluded > 0 ? 'neg' : 'pr-muted'}>
                  {formatNumber(scopeCounts.excluded)} ekskluderet
                </span>
                {scopeCounts.excluded > 0 && (
                  <Link href={`/feed/${feedId}/filters`} className="link">
                    Se reglerne
                  </Link>
                )}
              </>
            ) : (
              <span className="pr-muted">Tæller varer i feedet…</span>
            )}
          </p>

          <div className={`pr-tablewrap${loading ? ' is-loading' : ''}`} aria-busy={loading}>
            <table className="pr-table">
              <thead>
                <tr>
                  <th>Vare</th>
                  <th>Status</th>
                  <th>Titel i feedet</th>
                  <th className="r">Pris</th>
                  <th className="r">Lager</th>
                  <th aria-label="Fold ud" />
                </tr>
              </thead>
              <tbody>
                {!result ? (
                  <tr>
                    <td colSpan={6} className="pr-none">
                      Henter varer…
                    </td>
                  </tr>
                ) : products.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="pr-none">
                      {hasFilter ? 'Ingen varer matcher. Ryd søgning og filtre for at se alle.' : 'Ingen varer på denne side.'}
                    </td>
                  </tr>
                ) : (
                  products.map((p) => {
                    const id = p.source_id ?? String(p.id)
                    return (
                      <ProductRow
                        key={id}
                        feedId={feedId}
                        product={p}
                        view={result.feed[id] ?? null}
                        open={openId === id}
                        onToggle={() => setOpenId(openId === id ? null : id)}
                        metafieldNames={metafieldNames}
                      />
                    )
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="pr-pager">
            <label className="pr-size">
              Vis
              <select
                className="ff-select"
                value={pageSize}
                onChange={(e) => onFilter(setPageSize)(parseInt(e.target.value, 10))}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              pr. side
            </label>
            <span className="pr-muted">
              {products.length > 0
                ? `Viser ${formatNumber(firstShown)} til ${formatNumber(lastShown)}${total != null ? ` af ${formatNumber(total)}` : ''}`
                : ''}
            </span>
            <span className="pr-pagebtns">
              <button type="button" className="ff-btn-secondary" disabled={page <= 1 || loading} onClick={() => { setPage(page - 1); setOpenId(null) }}>
                Forrige
              </button>
              <button type="button" className="ff-btn-secondary" disabled={!canNext || loading} onClick={() => { setPage(page + 1); setOpenId(null) }}>
                Næste
              </button>
            </span>
          </div>
        </section>
      )}
    </div>
  )
}

// ── One product ─────────────────────────────────────────────────────────────

function formatPrice(price: string | undefined, currency: string | undefined): string {
  if (!price) return '—'
  const n = Number(price)
  const amount = Number.isFinite(n)
    ? n.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : price
  return currency ? `${amount} ${currency}` : amount
}

function stockOf(p: ShopifyProduct): number | null {
  const qs = p.variants.map((v) => v.inventory_quantity).filter((q): q is number => typeof q === 'number')
  return qs.length ? qs.reduce((a, b) => a + b, 0) : null
}

function feedValue(v: string | undefined): string {
  if (v === undefined) return ''
  if (v === '__AI__') return 'Skrives af AI ved generering'
  return v
}

function ProductRow({
  feedId,
  product,
  view,
  open,
  onToggle,
  metafieldNames,
}: {
  feedId: string
  product: ShopifyProduct
  view: FeedViewItem | null
  open: boolean
  onToggle: () => void
  metafieldNames: Map<string, string>
}) {
  const v0 = product.variants[0]
  const stock = stockOf(product)
  const feedTitle = view ? feedValue(view.fields.title) : ''
  const image = product.images[0]?.src

  return (
    <Fragment>
      <tr
        className={`pr-row${open ? ' open' : ''}`}
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        <td>
          <span className="pr-prod">
            {image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={image} alt="" className="pr-thumb" loading="lazy" />
            ) : (
              <span className="pr-thumb">
                <Icon name="box" size={14} />
              </span>
            )}
            <span>
              <b>{product.title || 'Uden titel'}</b>
              <small>{[product.vendor, product.source_id ?? product.id].filter(Boolean).join(' · ')}</small>
            </span>
          </span>
        </td>
        <td>
          {!view ? (
            <span className="pr-muted">…</span>
          ) : view.inFeed ? (
            <span className="st">I feed</span>
          ) : (
            <span className="neg" title={view.reason ?? undefined}>
              Ekskluderet
            </span>
          )}
        </td>
        <td className="pr-feedtitle">
          {!view ? '' : !view.inFeed ? <span className="pr-muted">—</span> : feedTitle || <span className="pr-muted">tom</span>}
        </td>
        <td className="r num">{formatPrice(v0?.price, v0?.currency)}</td>
        <td className={`r num${stock === 0 ? ' neg' : ''}`}>{stock == null ? '—' : formatNumber(stock)}</td>
        <td className="r">
          <Icon name="chevron-down" size={14} className="pr-chev" />
        </td>
      </tr>
      {open && (
        <tr className="pr-detail">
          <td colSpan={6}>
            <ProductDetail feedId={feedId} product={product} view={view} metafieldNames={metafieldNames} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}

function ProductDetail({
  feedId,
  product,
  view,
  metafieldNames,
}: {
  feedId: string
  product: ShopifyProduct
  view: FeedViewItem | null
  metafieldNames: Map<string, string>
}) {
  const fields = view?.fields ?? {}
  const ordered = [
    ...KEY_FIELDS.filter((f) => f in fields),
    ...Object.keys(fields).filter((f) => !KEY_FIELDS.includes(f)),
  ]

  return (
    <div className="pr-d">
      {view && !view.inFeed && view.reason && <p className="note warn">{view.reason}</p>}

      <div className="pr-cols">
        <section>
          <h4>Titel</h4>
          <dl className="pr-kv">
            <dt>I shoppen</dt>
            <dd>{product.title || <span className="pr-muted">tom</span>}</dd>
            <dt>I feedet</dt>
            <dd>
              <b>{view ? feedValue(fields.title) || <span className="pr-muted">tom</span> : '…'}</b>
            </dd>
          </dl>
          {product.variants.length > 1 && (
            <>
              <h4 className="pr-h4-gap">Varianter ({product.variants.length})</h4>
              <dl className="pr-kv">
                {product.variants.slice(0, 8).map((v) => (
                  <Fragment key={v.id}>
                    <dt>{v.title || v.sku || v.id}</dt>
                    <dd>
                      {formatPrice(v.price, v.currency)}
                      {typeof v.inventory_quantity === 'number' ? ` · ${formatNumber(v.inventory_quantity)} på lager` : ''}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              {product.variants.length > 8 && <p className="pr-muted pr-more">og {product.variants.length - 8} flere</p>}
            </>
          )}
        </section>

        <section>
          <h4>Værdier i feedet</h4>
          {!view ? (
            <p className="pr-muted">…</p>
          ) : ordered.length === 0 ? (
            <p className="pr-muted">Ingen felter er mappet endnu.</p>
          ) : (
            <dl className="pr-kv">
              {ordered.map((f) => (
                <Fragment key={f}>
                  <dt>{f}</dt>
                  <dd>{feedValue(fields[f]) || <span className="pr-muted">tom</span>}</dd>
                </Fragment>
              ))}
            </dl>
          )}
        </section>

        <section>
          <h4>Metafelter fra shoppen</h4>
          {product.metafields.length === 0 ? (
            <p className="pr-muted">Varen har ingen metafelter.</p>
          ) : (
            <dl className="pr-kv">
              {product.metafields.map((mf) => {
                const key = `${mf.namespace}.${mf.key}`
                return (
                  <Fragment key={key}>
                    <dt title={key}>{metafieldNames.get(key) ?? key}</dt>
                    <dd>{mf.value || <span className="pr-muted">tom</span>}</dd>
                  </Fragment>
                )
              })}
            </dl>
          )}
        </section>
      </div>

      <div className="pr-d-actions">
        <Link href={`/feed/${feedId}/mapping`} className="wl-btn-primary">
          Åbn i mapping
        </Link>
        {view && !view.inFeed && (
          <Link href={`/feed/${feedId}/filters`} className="wl-btn-secondary">
            Se reglerne
          </Link>
        )}
        <Link href={`/feed/${feedId}/google-ads`} className="link pr-d-perf">
          Se varens tal under Performance
        </Link>
      </div>
    </div>
  )
}
