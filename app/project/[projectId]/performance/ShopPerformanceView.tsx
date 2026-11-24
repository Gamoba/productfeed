import Link from 'next/link'
import type { ShopPerformance } from '@/lib/shopPerformance'
import { formatMoney, formatRatio } from '@/lib/googleAdsAnalytics'
import { channelOf } from '@/lib/channels'
import { countryName, formatNumber } from '@/lib/formatDa'
import { ChannelIcon } from '@/app/components/ChannelIcon'
import { flagEmoji } from '@/app/components/shell/nav'
import './performance.css'

export const WINDOWS = [7, 14, 30, 90] as const

// The page body, kept apart from page.tsx so it renders without data access.
export function ShopPerformanceView({ projectId, perf }: { projectId: string; perf: ShopPerformance }) {
  const { current, previous, currency, feeds, counted } = perf
  const connected = feeds.filter((f) => f.account)
  const money = (v: number | null) => formatMoney(v, currency)
  const poas = current.cost > 0 && perf.profitTracked ? current.profit / current.cost : null
  const poasBefore = previous.cost > 0 && perf.profitTracked ? previous.profit / previous.cost : null
  const noPrevious = previous.cost === 0 && previous.revenue === 0

  return (
    <div className="gp">
      <header className="gp-head">
        <div>
          <h1>General performance</h1>
          <p className="gp-lede">
            Shoppens samlede tal på tværs af kanaler og feeds. Klik på et feed for at se varerne bag tallene.
          </p>
        </div>
        <nav className="gp-seg" aria-label="Periode">
          {WINDOWS.map((w) => (
            <Link
              key={w}
              href={`/project/${projectId}/performance?days=${w}`}
              aria-current={w === perf.days ? 'true' : undefined}
            >
              {w}d
            </Link>
          ))}
        </nav>
      </header>

      {feeds.length === 0 ? (
        <section className="card gp-empty">
          <h3>Shoppen har ingen feeds endnu</h3>
          <p>Tallene kommer fra de Google Ads-konti, feedsene er koblet til. Opret et feed først.</p>
          <Link href={`/project/${projectId}`} className="wl-btn-primary">
            Gå til Feeds
          </Link>
        </section>
      ) : counted === 0 ? (
        <section className="card gp-empty">
          <h3>Ingen feeds har en Google Ads-konto endnu</h3>
          <p>
            Kobl en konto under Settings på det enkelte feed. Så samles forbrug, omsætning og profit her for hele
            shoppen.
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="gp-stats">
              <Stat label="Forbrug" value={money(current.cost)} change={pctChange(current.cost, previous.cost)} noPrevious={noPrevious} costLike />
              <Stat label="Omsætning" value={money(current.revenue)} change={pctChange(current.revenue, previous.revenue)} noPrevious={noPrevious} />
              <Stat
                label="Bruttoprofit"
                value={perf.profitTracked ? money(current.profit) : '—'}
                change={perf.profitTracked ? pctChange(current.profit, previous.profit) : null}
                noPrevious={noPrevious}
                missing={!perf.profitTracked ? 'Intet mål for profit valgt' : undefined}
              />
              <Stat
                label="POAS"
                value={formatRatio(poas)}
                change={poas !== null && poasBefore !== null ? { text: `${signed(poas - poasBefore, 2)} mod perioden før`, good: poas >= poasBefore } : null}
                noPrevious={noPrevious}
                missing={!perf.profitTracked ? 'Kræver et mål for profit' : undefined}
              />
            </div>
            <p className="gp-cover">
              <b>
                Tallene dækker {formatNumber(counted)} af {formatNumber(feeds.length)} feeds.
              </b>{' '}
              {coverageNote(perf)}
            </p>
          </section>

          <section className="card">
            <div className="gp-card-h">
              <div>
                <h3>{perf.profitTracked ? 'Forbrug mod profit' : 'Forbrug mod omsætning'}</h3>
                <small>
                  Pr. dag · {perf.profitTracked ? 'profit' : 'omsætning'} er fuldt optrukket, forbrug er stiplet · {perf.from} → {perf.to}
                </small>
              </div>
            </div>
            {perf.daily.some((d) => d.cost !== null) ? (
              <Chart perf={perf} />
            ) : (
              <p className="gp-nodata">
                Ingen tal i perioden. Vælg en længere periode, eller hent tallene på feedets Performance-side.
              </p>
            )}
          </section>
        </>
      )}

      {feeds.length > 0 && (
        <section className="card flush">
          <div className="gp-card-h gp-pad">
            <div>
              <h3>Feeds</h3>
              <small>Hvert feed har sin egen kobling til en annoncekonto</small>
            </div>
          </div>
          <div className="gp-tablewrap">
            <table className="gp-table">
              <thead>
                <tr>
                  <th>Feed</th>
                  <th>Annoncekonto</th>
                  <th className="r">Varer i feed</th>
                  <th className="r">Forbrug</th>
                  <th className="r">Profit</th>
                  <th className="r">POAS</th>
                  <th aria-label="Handling" />
                </tr>
              </thead>
              <tbody>
                {feeds.map((f) => {
                  const fm = (v: number | null) => formatMoney(v, f.currency)
                  const href = f.account ? `/feed/${f.feedId}/google-ads?days=${perf.days}` : `/feed/${f.feedId}/settings`
                  return (
                    <tr key={f.feedId}>
                      <td>
                        <Link href={href} className="gp-feed">
                          <ChannelIcon channel={f.channel} />
                          <span>
                            <b>{channelOf(f.channel).label}</b>
                            <small>
                              {[f.country ? `${flagEmoji(f.country)} ${countryName(f.country)}` : null, f.name].filter(Boolean).join(' · ')}
                            </small>
                          </span>
                        </Link>
                      </td>
                      <td className="gp-acct">
                        {f.account ?? <span className="gp-muted">Ikke koblet</span>}
                        {f.excluded === 'duplicate' && <small className="gp-why">Samme konto som {f.duplicateOf}, tælles én gang</small>}
                        {f.excluded === 'currency' && <small className="gp-why">{f.currency}, ikke med i summen</small>}
                      </td>
                      <td className="r num">{f.items != null ? formatNumber(f.items) : <span className="gp-muted">—</span>}</td>
                      <td className="r num">{f.account ? fm(f.cost) : <span className="gp-muted">Ingen tal</span>}</td>
                      <td className="r num">{f.account && f.profit !== null ? fm(f.profit) : ''}</td>
                      <td className="r num">
                        {f.account && f.profit !== null && f.cost ? formatRatio(f.profit / f.cost) : ''}
                      </td>
                      <td className="r">
                        <Link href={href} className="link">
                          {f.account ? 'Åbn feed' : 'Kobl konto'}
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {connected.length > 0 && (
        <p className="gp-notes">
          Hvert feed regnes med sine egne mål for omsætning og profit fra feedets Settings. Kun forbrug, Google kan
          knytte til en vare, er med.
        </p>
      )}
    </div>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

type Change = { text: string; good: boolean } | null

function pctChange(now: number, before: number): Change {
  if (before <= 0) return null
  const pct = (now - before) / before
  return { text: `${signed(pct * 100, 0)} % mod perioden før`, good: pct >= 0 }
}

function signed(v: number, digits: number): string {
  const s = Math.abs(v).toLocaleString('da-DK', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return `${v >= 0 ? '+' : '−'}${s}`
}

function Stat({
  label,
  value,
  change,
  noPrevious,
  missing,
  costLike,
}: {
  label: string
  value: string
  change: Change
  noPrevious: boolean
  missing?: string
  costLike?: boolean
}) {
  // More spend is not "good" by itself, so spend's change stays neutral.
  const cls = !change || costLike ? '' : change.good ? 'pos' : 'neg'
  return (
    <div>
      <span>{label}</span>
      <strong className="num">{value}</strong>
      <small className={cls}>{missing ?? change?.text ?? (noPrevious ? 'Ingen tal for perioden før' : ' ')}</small>
    </div>
  )
}

function coverageNote(perf: ShopPerformance): string {
  const unlinked = perf.feeds.filter((f) => !f.account).length
  const dup = perf.feeds.filter((f) => f.excluded === 'duplicate').length
  const cur = perf.feeds.filter((f) => f.excluded === 'currency').length
  const parts: string[] = []
  if (unlinked) parts.push(`${unlinked} ${unlinked === 1 ? 'feed har' : 'feeds har'} ingen Ads-konto. Kobl en under Settings på feedet, så tæller det med.`)
  if (dup) parts.push(`${dup} deler konto og feed label med et andet feed og tælles kun én gang.`)
  if (cur) parts.push(`${cur} rapporterer i en anden valuta end ${perf.currency ?? 'resten'} og er ikke med i summen.`)
  return parts.join(' ') || 'Alle feeds har en Ads-konto koblet til.'
}

// Daily line chart: profit (or revenue) solid, spend dashed. Days without data
// break the line instead of drawing it through zero.
function Chart({ perf }: { perf: ShopPerformance }) {
  const W = 900
  const H = 200
  const pad = { l: 56, r: 12, t: 10, b: 24 }
  const main = perf.daily.map((d) => (perf.profitTracked ? d.profit : d.revenue))
  const cost = perf.daily.map((d) => d.cost)
  const max = Math.max(1, ...main.map((v) => v ?? 0), ...cost.map((v) => v ?? 0))
  const n = perf.daily.length
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r))
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b)

  const path = (vals: (number | null)[]) => {
    let d = ''
    let pen = false
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false
        return
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`
      pen = true
    })
    return d
  }

  const ticks = [0, 0.5, 1].map((t) => t * max)
  const labelIdx = n <= 1 ? [0] : [0, Math.round((n - 1) / 2), n - 1]
  const lastMain = [...main].reverse().findIndex((v) => v !== null)
  const lastI = lastMain === -1 ? -1 : n - 1 - lastMain

  return (
    <svg className="gp-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Forbrug og ${perf.profitTracked ? 'profit' : 'omsætning'} pr. dag`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="gp-grid" />
          <text x={pad.l - 8} y={y(t) + 3.5} textAnchor="end">
            {formatNumber(Math.round(t))}
          </text>
        </g>
      ))}
      {labelIdx.map((i) => (
        <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
          {shortDate(perf.daily[i]?.date)}
        </text>
      ))}
      <path d={path(cost)} className="gp-line gp-cost" />
      <path d={path(main)} className="gp-line gp-main" />
      {lastI >= 0 && main[lastI] !== null && <circle cx={x(lastI)} cy={y(main[lastI] as number)} r={3.5} className="gp-dot" />}
    </svg>
  )
}

function shortDate(iso: string | undefined): string {
  if (!iso) return ''
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

