'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { PreviewData, PreviewRow } from '@/lib/feedGenerator'
import { channelOf } from '@/lib/channels'
import { formatNumber, formatWhen } from '@/lib/formatDa'
import { Icon, type IconName } from '../components/shell/icons'
import './preview.css'

// Feed › Preview & eksport — setup step 5 of 5. The link the channel fetches
// the feed from, the path every product takes from source to channel, and each
// product as it stands in the feed (as fields, or as the XML item).

export type PipelineInfo = {
  source: 'shopify' | 'feed_url'
  lastSynced: string | null
  optimizedTitles: number
  labels: number
  labelsComputed: number
  generatedAt: string | null
  productCount: number | null
  errors: number
  warnings: number
  validated: boolean
}

const REQUIRED = new Set(['id', 'title', 'description', 'link', 'image_link', 'price', 'availability'])

// Where each channel picks the feed up.
const CHANNEL_TARGET: Record<string, string> = {
  google_shopping: 'Merchant Center',
  meta_catalog: 'Meta Commerce Manager',
  daisycon: 'Daisycon',
  microsoft_ads: 'Microsoft Merchant Center',
}

type View = 'product' | 'field' | 'xml'

export function PreviewClient({
  feedId,
  channel,
  data: initialData,
  pipeline,
}: {
  feedId: string
  channel: string
  data: PreviewData
  pipeline: PipelineInfo
}) {
  // ~20 rows arrive from the server; upgrade to a 100-row sample after mount.
  const [data, setData] = useState<PreviewData>(initialData)
  const [upgrading, setUpgrading] = useState(true)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/preview?feedId=${encodeURIComponent(feedId)}&limit=100`)
      .then((r) => (r.ok ? r.json() : null))
      .then((full: PreviewData | null) => {
        if (!cancelled && full) setData(full)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setUpgrading(false)
      })
    return () => {
      cancelled = true
    }
  }, [feedId])

  const [generated, setGenerated] = useState({ at: pipeline.generatedAt, count: pipeline.productCount })
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  async function regenerate() {
    setGenerating(true)
    setGenError(null)
    try {
      const res = await fetch(`/api/feed/generate/${feedId}`, { method: 'POST' })
      const j = (await res.json().catch(() => ({}))) as { generated_at?: string; product_count?: number; error?: string }
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setGenerated({ at: j.generated_at ?? new Date().toISOString(), count: j.product_count ?? null })
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Feedet kunne ikke genereres')
    } finally {
      setGenerating(false)
    }
  }

  const ch = channelOf(channel)
  const target = CHANNEL_TARGET[ch.id] ?? ch.label

  return (
    <div className="pv">
      <div className="pv-head">
        <div>
          <h1>Preview &amp; eksport</h1>
          <p className="pv-lede">
            Linket {target} henter feedet fra, vejen fra kilde til kanal, og hver vare, som den står i feedet.
          </p>
        </div>
        <div className="pv-actions">
          <a href={`/api/feed/generate/${feedId}`} target="_blank" rel="noopener noreferrer" className="wl-btn-secondary">
            Åbn XML
          </a>
          <button type="button" className="wl-btn-primary" onClick={() => void regenerate()} disabled={generating}>
            {generating ? 'Genererer…' : 'Generér nu'}
          </button>
        </div>
      </div>

      {genError && <p className="note warn">Feedet kunne ikke genereres: {genError}</p>}

      <section className="card">
        <p className="pv-label">Link til feedet · brug det i {target}</p>
        <UrlBox feedId={feedId} />
        <p className="pv-muted pv-small">
          {generated.at
            ? `Genereret ${formatWhen(generated.at)}${generated.count != null ? ` med ${formatNumber(generated.count)} varer` : ''}. Linket giver altid den seneste version.`
            : 'Feedet er ikke genereret endnu. Linket bygger det første gang, det hentes.'}
        </p>
      </section>

      <Pipeline feedId={feedId} data={data} pipeline={pipeline} generated={generated} target={target} channelLabel={ch.label} />

      <ItemPreview data={data} upgrading={upgrading} />

      <div className="pv-step">
        <span>Trin 5 af 5 i opsætningen af feedet</span>
        <Link href={`/feed/${feedId}/google-ads/labels`} className="wl-btn-secondary">
          Tilbage til Labels
        </Link>
        <Link href={`/feed/${feedId}`} className="wl-btn-primary">
          Færdig. Se feed status
        </Link>
      </div>
    </div>
  )
}

function UrlBox({ feedId }: { feedId: string }) {
  const [copied, setCopied] = useState(false)
  // window is only available after mount; the path alone is shown until then.
  const [origin, setOrigin] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setOrigin(window.location.origin), 0)
    return () => clearTimeout(t)
  }, [])
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/api/feed/generate/${feedId}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked: the URL is visible and can be copied by hand.
    }
  }
  return (
    <div className="pv-url">
      <Icon name="link" size={16} />
      <span className="pv-url-text">
        {origin}/api/feed/generate/{feedId}
      </span>
      <button type="button" className="ff-btn-primary" onClick={() => void copy()}>
        {copied ? '✓ Kopieret' : 'Kopiér link'}
      </button>
    </div>
  )
}

// ── Fra kilde til kanal ─────────────────────────────────────────────────────

type Stage = { icon: IconName; title: string; detail: string; bad?: boolean; href?: string }

function Pipeline({
  feedId,
  data,
  pipeline,
  generated,
  target,
  channelLabel,
}: {
  feedId: string
  data: PreviewData
  pipeline: PipelineInfo
  generated: { at: string | null; count: number | null }
  target: string
  channelLabel: string
}) {
  const f = (p: string) => `/feed/${feedId}${p}`
  const stages: Stage[] = [
    {
      icon: 'box',
      title: pipeline.source === 'feed_url' ? 'Hent fra feed-URL' : 'Hent fra Shopify',
      detail: pipeline.lastSynced ? `Synket ${formatWhen(pipeline.lastSynced)}` : 'Aldrig synket',
      bad: !pipeline.lastSynced,
      href: f('/products'),
    },
    {
      icon: 'filter',
      title: 'Inkludér / ekskludér',
      detail: `${formatNumber(data.totalProducts)} ${data.feedMode === 'variant' ? 'varer (før varianter)' : 'varer'} med`,
      href: f('/filters'),
    },
    {
      icon: 'mapping',
      title: 'Mapping',
      detail: `${data.googleFields.length} felter`,
      bad: data.googleFields.length === 0,
      href: f('/mapping'),
    },
    {
      icon: 'titles',
      title: 'AI Titles',
      detail: pipeline.optimizedTitles ? `${formatNumber(pipeline.optimizedTitles)} godkendte titler` : 'Ingen endnu',
      href: f('/optimize'),
    },
    {
      icon: 'tag',
      title: 'Labels',
      detail: pipeline.labels
        ? `${pipeline.labelsComputed} af ${pipeline.labels} beregnet · ikke i feedet endnu`
        : 'Ingen labels',
      href: f('/google-ads/labels'),
    },
    {
      icon: 'check',
      title: 'Validering',
      detail: !pipeline.validated
        ? 'Ikke valideret'
        : pipeline.errors
          ? `${formatNumber(pipeline.errors)} fejl`
          : pipeline.warnings
            ? `${formatNumber(pipeline.warnings)} ${pipeline.warnings === 1 ? 'advarsel' : 'advarsler'}`
            : 'Ingen fejl',
      bad: pipeline.errors > 0 || pipeline.warnings > 0,
      href: f(''),
    },
    {
      icon: 'feeds',
      title: `Hentes af ${target}`,
      detail: generated.at
        ? `${channelLabel} · ${generated.count != null ? `${formatNumber(generated.count)} varer` : 'genereret'} ${formatWhen(generated.at)}`
        : 'Ikke genereret endnu',
      bad: !generated.at,
    },
  ]

  return (
    <section className="card">
      <div className="pv-card-h">
        <h3>Fra kilde til kanal</h3>
        <small>Hver vare går gennem trinene i denne rækkefølge. Klik på et trin for at rette det.</small>
      </div>
      <ol className="pv-pipe">
        {stages.map((s, i) => {
          const inner = (
            <>
              <span className={`pv-ic${s.bad ? ' bad' : ''}`}>
                <Icon name={s.icon} size={14} />
              </span>
              <span className="pv-st">
                <b>{s.title}</b>
                <small className={s.bad ? 'neg' : undefined}>{s.detail}</small>
              </span>
            </>
          )
          return (
            <li key={i}>
              {s.href ? (
                <Link href={s.href} className="pv-stage">
                  {inner}
                </Link>
              ) : (
                <span className="pv-stage">{inner}</span>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

// ── One product, as fields or as XML; or one field across products ─────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// The <item> the generator writes for this row (lib/feedGenerator xmlLine):
// every field as <g:name>, custom fields with their own name, empty values left
// out. AI fields are filled in at generation, so they show as a comment here.
function itemXml(row: PreviewRow, fields: string[]): string {
  const lines = ['<item>']
  for (const f of fields) {
    const v = row.fields[f]
    const tag = f.startsWith('custom:') ? f.slice('custom:'.length) : f
    if (v === '__AI__') lines.push(`  <!-- g:${tag}: skrives af AI ved generering -->`)
    else if (v) lines.push(`  <g:${tag}>${xmlEscape(v)}</g:${tag}>`)
  }
  lines.push('</item>')
  return lines.join('\n')
}

function Value({ value }: { value: string | undefined }) {
  if (value === '__AI__') return <span className="pill ai">Skrives af AI</span>
  if (!value) return <span className="pv-muted">tom</span>
  if (value.startsWith('http'))
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="link pv-break">
        {value}
      </a>
    )
  return <span className="pv-val">{value}</span>
}

function ItemPreview({ data, upgrading }: { data: PreviewData; upgrading: boolean }) {
  const [view, setView] = useState<View>('product')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [field, setField] = useState<string>('title')
  const rows = data.rows
  const fields = data.googleFields

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? rows.filter((r) => r.title.toLowerCase().includes(q) || r.productId.includes(q)) : rows
  }, [rows, search])
  const selected = rows.find((r) => r.productId === selectedId) ?? filtered[0] ?? null
  const unmappedRequired = [...REQUIRED].filter((f) => !fields.includes(f))
  const activeField = fields.includes(field) ? field : (fields[0] ?? '')

  return (
    <section className={`card flush${upgrading ? ' pv-upgrading' : ''}`}>
      <div className="pv-ip-h">
        <div className="pv-card-h">
          <h3>Varerne i feedet</h3>
          <small>
            {formatNumber(rows.length)} {data.feedMode === 'variant' ? 'varianter' : 'varer'} vist
            {data.totalProducts > rows.length ? ` af ${formatNumber(data.totalProducts)} varer i feedet` : ''} ·{' '}
            {fields.length} felter
          </small>
        </div>
        <div className="pv-seg" role="tablist" aria-label="Visning">
          {(
            [
              ['product', 'Én vare'],
              ['xml', 'XML'],
              ['field', 'Ét felt'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {unmappedRequired.length > 0 && (
        <p className="note warn pv-inset">
          Påkrævede felter er ikke mappet: {unmappedRequired.join(', ')}.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="pv-muted pv-pad">Ingen varer er med i feedet med de nuværende regler.</p>
      ) : view === 'field' ? (
        <div className="pv-pad">
          <label className="pv-fieldpick">
            Felt
            <select className="ff-select" value={activeField} onChange={(e) => setField(e.target.value)}>
              {fields.map((f) => (
                <option key={f} value={f}>
                  {f.replace(/^custom:/, '')}
                </option>
              ))}
            </select>
            <span className="pv-muted">
              {formatNumber(rows.filter((r) => !r.fields[activeField]).length)} tomme af {formatNumber(rows.length)}
            </span>
          </label>
          <table className="pv-table">
            <tbody>
              {rows.slice(0, 50).map((r) => (
                <tr key={r.productId}>
                  <td className="pv-t">{r.title || 'Uden titel'}</td>
                  <td>
                    <Value value={r.fields[activeField]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pv-split">
          <div className="pv-list">
            <label className="pv-search">
              <Icon name="search" size={13} />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Søg vare"
                aria-label="Søg vare"
              />
            </label>
            <ul>
              {filtered.map((r) => (
                <li key={r.productId}>
                  <button
                    type="button"
                    aria-pressed={selected?.productId === r.productId}
                    onClick={() => setSelectedId(r.productId)}
                  >
                    <b>{r.title || 'Uden titel'}</b>
                    <small>{r.productId}</small>
                  </button>
                </li>
              ))}
              {filtered.length === 0 && <li className="pv-muted pv-small pv-none">Ingen varer matcher.</li>}
            </ul>
          </div>
          <div className="pv-detail">
            {!selected ? (
              <p className="pv-muted">Vælg en vare til venstre.</p>
            ) : view === 'xml' ? (
              <pre className="pv-code">{itemXml(selected, fields)}</pre>
            ) : (
              <dl className="pv-kv">
                {fields.map((f) => {
                  const v = selected.fields[f]
                  const missing = REQUIRED.has(f) && !v
                  return (
                    <div key={f} className={missing ? 'missing' : undefined}>
                      <dt>
                        {f.replace(/^custom:/, '')}
                        {REQUIRED.has(f) && <span className="pv-req" title="Påkrævet"> *</span>}
                      </dt>
                      <dd>{missing ? <span className="neg">Mangler</span> : <Value value={v} />}</dd>
                    </div>
                  )
                })}
              </dl>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
