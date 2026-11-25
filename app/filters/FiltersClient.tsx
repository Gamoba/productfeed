'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useEffect, useRef, useState, useTransition } from 'react'
import { saveFilters, getFeedMetafields } from './actions'
import type { FilterRule, FilterConfig } from './actions'
import { RuleRow, defaultRule, defaultConfig, type MetafieldOption } from '@/app/components/FilterEditor'
import type { ScopePreview } from '@/lib/feedGenerator'
import { formatNumber } from '@/lib/formatDa'
import { Icon } from '../components/shell/icons'
import './filters.css'
import { markFeedEdited } from '@/lib/recentEdit'

// Feed › Inkludér / ekskludér (reference: references/feed_include_exclude.jpg).
// Pick a side at the top (the included or the excluded products), edit the
// rules for that side, and see straight away — before saving — what they do:
// counts per rule and a searchable list of the products on that side. The
// numbers come from the same filter code the generator uses.

type Side = 'include' | 'exclude'

const PREVIEW_DEBOUNCE_MS = 450

export function FiltersClient({
  feedId,
  initialInclude,
  initialExclude,
}: {
  feedId: string
  initialInclude: { operator: 'AND' | 'OR'; rules: FilterRule[] } | null
  initialExclude: { operator: 'AND' | 'OR'; rules: FilterRule[] } | null
}) {
  const router = useRouter()
  const [include, setInclude] = useState<FilterConfig>(initialInclude ?? defaultConfig())
  const [exclude, setExclude] = useState<FilterConfig>(initialExclude ?? defaultConfig())
  const [saved, setSaved] = useState(() => JSON.stringify([initialInclude ?? defaultConfig(), initialExclude ?? defaultConfig()]))
  const [side, setSide] = useState<Side>('exclude')
  const [search, setSearch] = useState('')
  const [isPending, startTransition] = useTransition()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)

  const [metafields, setMetafields] = useState<MetafieldOption[] | undefined>(undefined)
  useEffect(() => {
    getFeedMetafields(feedId).then((r) => {
      if ('data' in r) setMetafields(r.data)
    })
  }, [feedId])

  // ── Live preview of the rules as they stand (saved or not) ──
  const previewKey = JSON.stringify([include, exclude, side, search.trim()])
  const [preview, setPreview] = useState<{ key: string; data: ScopePreview } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  useEffect(() => {
    const t = setTimeout(() => {
      ctrl.current?.abort()
      const c = new AbortController()
      ctrl.current = c
      fetch(`/api/feeds/${encodeURIComponent(feedId)}/scope-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include, exclude, show: side === 'include' ? 'included' : 'excluded', search: search.trim(), limit: 50 }),
        signal: c.signal,
      })
        .then(async (r) => {
          const d = (await r.json()) as ScopePreview & { error?: string }
          if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`)
          setPreviewError(null)
          setPreview({ key: previewKey, data: d })
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return
          setPreviewError(e instanceof Error ? e.message : 'Previewet kunne ikke beregnes')
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [feedId, include, exclude, side, search, previewKey])
  useEffect(() => () => ctrl.current?.abort(), [])

  const stale = preview?.key !== previewKey
  const data = preview?.data ?? null
  const dirty = JSON.stringify([include, exclude]) !== saved

  const config = side === 'include' ? include : exclude
  const setConfig = side === 'include' ? setInclude : setExclude
  const ruleStats = side === 'include' ? data?.includeRules : data?.excludeRules
  const otherCount = (side === 'include' ? exclude : include).rules.length

  function save(then?: () => void) {
    setSaveError(null)
    startTransition(async () => {
      const result = await saveFilters(feedId, include, exclude)
      if (result.error) {
        setSaveError(result.error)
        return
      }
      markFeedEdited(feedId)
      setSaved(JSON.stringify([include, exclude]))
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2500)
      then?.()
    })
  }

  return (
    <div className="fl">
      <div className="fl-head">
        <div>
          <h1>Inkludér og ekskludér produkter</h1>
          <p className="fl-lede">
            Bestem hvilke varer der kommer med i feedet. Vælg øverst, om du arbejder med de inkluderede eller
            de ekskluderede, og se i previewet, hvor hver vare lander. Intet ændres, før du gemmer.
          </p>
        </div>
        <div className="fl-actions">
          {dirty && !isPending && <span className="fl-dirty">Ikke gemt</span>}
          <button type="button" className="wl-btn-primary" onClick={() => save()} disabled={isPending || !dirty}>
            {isPending ? 'Gemmer…' : justSaved ? '✓ Gemt' : 'Gem'}
          </button>
        </div>
      </div>

      {saveError && <p className="note warn">Reglerne kunne ikke gemmes: {saveError}</p>}

      <div className="fl-sidebar">
        <div className="fl-seg" role="tablist" aria-label="Vælg side">
          {(['include', 'exclude'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={side === s}
              onClick={() => setSide(s)}
            >
              {s === 'include' ? 'Inkluderede produkter' : 'Ekskluderede produkter'}
              <b className="num">{data ? formatNumber(s === 'include' ? data.included : data.excluded) : '…'}</b>
            </button>
          ))}
        </div>
        <span className="fl-total">{data ? `${formatNumber(data.total)} aktive varer i shoppen` : 'Tæller varer…'}</span>
      </div>

      <div className="fl-grid">
        <section className="card">
          <div className="fl-card-h">
            <h3>{side === 'include' ? 'Regler for inkludering' : 'Regler for ekskludering'}</h3>
            <small>
              {side === 'include'
                ? 'Kun varer der matcher, kommer med. Ingen regler betyder, at alle aktive varer kommer med.'
                : 'Varer der matcher, tages ud af feedet. Tjekkes efter inkluderingen.'}
            </small>
          </div>

          {config.rules.length === 0 ? (
            <p className="fl-empty">Ingen regler endnu.</p>
          ) : (
            <div className="fl-rules">
              {config.rules.map((rule, i) => (
                <div className="fl-rule" key={i}>
                  {i === 0 ? (
                    <span className="fl-kw">HVIS</span>
                  ) : (
                    <button
                      type="button"
                      className="fl-kw fl-kw-btn"
                      title="Skift mellem OG og ELLER for alle regler"
                      onClick={() => setConfig((c) => ({ ...c, operator: c.operator === 'AND' ? 'OR' : 'AND' }))}
                    >
                      {config.operator === 'AND' ? 'OG' : 'ELLER'}
                    </button>
                  )}
                  <div className="fl-rule-body">
                    <RuleRow
                      rule={rule}
                      metafieldOptions={metafields}
                      onChange={(patch) =>
                        setConfig((c) => ({ ...c, rules: c.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) }))
                      }
                      onDelete={() => setConfig((c) => ({ ...c, rules: c.rules.filter((_, j) => j !== i) }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            className="fl-add"
            onClick={() => setConfig((c) => ({ ...c, rules: [...c.rules, defaultRule()] }))}
          >
            + Tilføj regel
          </button>

          {(ruleStats?.length ?? 0) > 0 && (
            <div className={`fl-stats${stale ? ' is-stale' : ''}`}>
              <p className="fl-label">
                {side === 'include' ? 'Så mange varer holder hver regel ude' : 'Så mange varer tager hver regel ud'}
              </p>
              <dl>
                {ruleStats!.map((r, i) => (
                  <Fragment key={i}>
                    <dt>{r.label}</dt>
                    <dd className={r.count > 0 ? 'neg num' : 'fl-muted num'}>{formatNumber(r.count)}</dd>
                  </Fragment>
                ))}
              </dl>
              {config.operator === 'AND' && config.rules.length > 1 && (
                <p className="fl-muted fl-small">
                  Reglerne gælder samlet (OG), så tallene her er for hver regel alene.
                </p>
              )}
            </div>
          )}
          {otherCount > 0 && (
            <p className="fl-muted fl-small">
              Der er også {otherCount} {otherCount === 1 ? 'regel' : 'regler'} for{' '}
              <button type="button" className="fl-link" onClick={() => setSide(side === 'include' ? 'exclude' : 'include')}>
                {side === 'include' ? 'ekskludering' : 'inkludering'}
              </button>
              .
            </p>
          )}
        </section>

        <section className="card">
          <div className="fl-card-h">
            <h3>Preview</h3>
            <small>Søg en vare frem og se, om den bliver {side === 'include' ? 'inkluderet' : 'ekskluderet'}, og hvorfor.</small>
          </div>
          <label className="fl-search">
            <Icon name="search" size={14} />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Søg på titel, producent eller id"
              aria-label="Søg i previewet"
            />
          </label>

          {previewError ? (
            <p className="note warn">{previewError}</p>
          ) : !data ? (
            <p className="fl-muted fl-small">Regner på reglerne… Første gang kan tage lidt tid på en stor shop.</p>
          ) : (
            <div className={stale ? 'is-stale' : undefined} aria-busy={stale}>
              {data.products.length === 0 ? (
                <p className="fl-muted fl-small fl-none">
                  {search.trim()
                    ? 'Ingen varer matcher søgningen på denne side.'
                    : side === 'include'
                      ? 'Ingen varer kommer med i feedet med disse regler.'
                      : 'Ingen varer bliver ekskluderet med disse regler.'}
                </p>
              ) : (
                <ul className="fl-list">
                  {data.products.map((p) => (
                    <li key={p.id}>
                      {p.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.image} alt="" className="fl-thumb" loading="lazy" />
                      ) : (
                        <span className="fl-thumb">
                          <Icon name="box" size={13} />
                        </span>
                      )}
                      <span className="fl-p">
                        <b>{p.title}</b>
                        <small>
                          {[p.vendor, p.id, p.stock != null ? `lager ${formatNumber(p.stock)}` : null].filter(Boolean).join(' · ')}
                        </small>
                      </span>
                      <span className="fl-state">
                        {p.inFeed ? <span className="st">Inkluderet</span> : <span className="neg">Ekskluderet</span>}
                        {p.reason && <small>{p.reason}</small>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="fl-muted fl-small">
                Viser {formatNumber(data.products.length)} af {formatNumber(data.matching)}{' '}
                {side === 'include' ? 'inkluderede' : 'ekskluderede'} varer
                {search.trim() ? ' der matcher søgningen' : ''}.
              </p>
            </div>
          )}
        </section>
      </div>

      <div className="fl-step">
        <span>Trin 2 af 5 i opsætningen af feedet</span>
        <Link href={`/feed/${feedId}/mapping`} className="wl-btn-secondary">
          Tilbage til Mapping
        </Link>
        <button
          type="button"
          className="wl-btn-primary"
          disabled={isPending}
          onClick={() => (dirty ? save(() => router.push(`/feed/${feedId}/optimize`)) : router.push(`/feed/${feedId}/optimize`))}
        >
          {dirty ? 'Gem og videre til AI Titles' : 'Videre til AI Titles'}
        </button>
      </div>
    </div>
  )
}
