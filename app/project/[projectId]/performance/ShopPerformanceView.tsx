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
            The shop&apos;s combined figures across channels and feeds. Click a feed to see the products behind the numbers.
          </p>
        </div>
        <nav className="gp-seg" aria-label="Period">
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
          <h3>This shop has no feeds yet</h3>
          <p>The figures come from the Google Ads accounts your feeds are linked to. Create a feed first.</p>
          <Link href={`/project/${projectId}`} className="wl-btn-primary">
            Go to Feeds
          </Link>
        </section>
      ) : counted === 0 ? (
        <section className="card gp-empty">
          <h3>No feeds have a Google Ads account yet</h3>
          <p>
            Link an account under Settings on each feed. Spend, revenue and profit for the whole shop are then
            collected here.
          </p>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="gp-stats">
              <Stat label="Spend" value={money(current.cost)} change={pctChange(current.cost, previous.cost)} noPrevious={noPrevious} costLike />
              <Stat label="Revenue" value={money(current.revenue)} change={pctChange(current.revenue, previous.revenue)} noPrevious={noPrevious} />
              <Stat
                label="Gross profit"
                value={perf.profitTracked ? money(current.profit) : '—'}
                change={perf.profitTracked ? pctChange(current.profit, previous.profit) : null}
                noPrevious={noPrevious}
                missing={!perf.profitTracked ? 'No profit goal selected' : undefined}
              />
              <Stat
                label="POAS"
                value={formatRatio(poas)}
                change={poas !== null && poasBefore !== null ? { text: `${signed(poas - poasBefore, 2)} vs previous period`, good: poas >= poasBefore } : null}
                noPrevious={noPrevious}
                missing={!perf.profitTracked ? 'Requires a profit goal' : undefined}
              />
            </div>
            <p className="gp-cover">
              <b>
                The figures cover {formatNumber(counted)} of {formatNumber(feeds.length)} feeds.
              </b>{' '}
              {coverageNote(perf)}
            </p>
          </section>

          <section className="card">
            <div className="gp-card-h">
              <div>
                <h3>{perf.profitTracked ? 'Spend vs profit' : 'Spend vs revenue'}</h3>
                <small>
                  Per day · {perf.profitTracked ? 'profit' : 'revenue'} is solid, spend is dashed · {perf.from} → {perf.to}
                </small>
              </div>
            </div>
            {perf.daily.some((d) => d.cost !== null) ? (
              <Chart perf={perf} />
            ) : (
              <p className="gp-nodata">
                No figures for this period. Choose a longer period, or fetch the figures on the feed&apos;s Performance page.
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
              <small>Each feed has its own link to an ad account</small>
            </div>
          </div>
          <div className="gp-tablewrap">
            <table className="gp-table">
              <thead>
                <tr>
                  <th>Feed</th>
                  <th>Ad account</th>
                  <th className="r">Products in feed</th>
                  <th className="r">Spend</th>
                  <th className="r">Profit</th>
                  <th className="r">POAS</th>
                  <th aria-label="Action" />
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
                        {f.account ?? <span className="gp-muted">Not linked</span>}
                        {f.excluded === 'duplicate' && <small className="gp-why">Same account as {f.duplicateOf}, counted once</small>}
                        {f.excluded === 'currency' && <small className="gp-why">{f.currency}, not included in the total</small>}
                      </td>
                      <td className="r num">{f.items != null ? formatNumber(f.items) : <span className="gp-muted">—</span>}</td>
                      <td className="r num">{f.account ? fm(f.cost) : <span className="gp-muted">No figures</span>}</td>
                      <td className="r num">{f.account && f.profit !== null ? fm(f.profit) : ''}</td>
                      <td className="r num">
                        {f.account && f.profit !== null && f.cost ? formatRatio(f.profit / f.cost) : ''}
                      </td>
                      <td className="r">
                        <Link href={href} className="link">
                          {f.account ? 'Open feed' : 'Link account'}
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
          Each feed is counted with its own revenue and profit goals from the feed&apos;s Settings. Only spend Google can
          attribute to a product is included.
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
  return { text: `${signed(pct * 100, 0)} % vs previous period`, good: pct >= 0 }
}

function signed(v: number, digits: number): string {
  const s = Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })
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
      <small className={cls}>{missing ?? change?.text ?? (noPrevious ? 'No figures for the previous period' : ' ')}</small>
    </div>
  )
}

function coverageNote(perf: ShopPerformance): string {
  const unlinked = perf.feeds.filter((f) => !f.account).length
  const dup = perf.feeds.filter((f) => f.excluded === 'duplicate').length
  const cur = perf.feeds.filter((f) => f.excluded === 'currency').length
  const parts: string[] = []
  if (unlinked) parts.push(`${unlinked} ${unlinked === 1 ? 'feed has' : 'feeds have'} no Ads account. Link one under Settings on the feed to include it.`)
  if (dup) parts.push(`${dup} share an account and feed label with another feed and are counted only once.`)
  if (cur) parts.push(`${cur} report in a currency other than ${perf.currency ?? 'the rest'} and are not included in the total.`)
  return parts.join(' ') || 'All feeds have an Ads account linked.'
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
    <svg className="gp-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Spend and ${perf.profitTracked ? 'profit' : 'revenue'} per day`}>
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
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

