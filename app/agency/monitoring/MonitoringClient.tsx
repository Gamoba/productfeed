import Link from 'next/link'
import type { AgencyMonitoring, MonitoringIssue } from '@/lib/agencyMonitoring'
import { channelOf } from '@/lib/channels'
import { countryName, formatNumber, formatWhen } from '@/lib/formatDa'
import { flagEmoji, initials } from '@/app/components/shell/nav'
import '../agency.css'
import './monitoring.css'

const n1 = (n: number, one: string, many: string) => (n === 1 ? one : many.replace('{n}', formatNumber(n)))
const pct = (q: number) => `${Math.round(q * 100)} %`
const WARN_LIMIT = 8

function feedLabel(i: MonitoringIssue): string {
  const channel = channelOf(i.channel).label
  return i.country ? `${flagEmoji(i.country)} ${channel} in ${countryName(i.country)}` : `${channel} · ${i.feedName ?? ''}`
}

function issueText(i: MonitoringIssue): { title: string; sub: string; href: string } {
  const when = i.at ? ` · ${formatWhen(i.at)}` : ''
  switch (i.kind) {
    case 'connection':
      return { title: 'Shopify connection fails', sub: '{shop} · products can’t be fetched'.replace('{shop}', i.shopName), href: `/project/${i.shopId}/connections` }
    case 'feed_errors':
      return {
        title: `${feedLabel(i)}: ${n1(i.count, '1 error', '{n} errors')}`,
        sub: [i.shopName, i.message].filter(Boolean).join(' · '),
        href: `/feed/${i.feedId}`,
      }
    case 'stale':
      return { title: `${feedLabel(i)}: ${'products not synced for {d} days'.replace('{d}', String(i.count))}`, sub: `${i.shopName}${when}`, href: `/feed/${i.feedId}/products` }
    case 'sync_failed':
      return {
        title: `${feedLabel(i)}: automatic sync failed`,
        sub: [i.shopName, i.message].filter(Boolean).join(' · ') + when,
        href: `/feed/${i.feedId}/settings`,
      }
    case 'feed_warnings':
      return {
        title: `${feedLabel(i)}: ${n1(i.count, '1 warning', '{n} warnings')}`,
        sub: `${i.shopName} · not critical`,
        href: `/feed/${i.feedId}`,
      }
  }
}

function IssueList({ items }: { items: MonitoringIssue[] }) {
  return (
    <div className="mo-issues">
      {items.map((i) => {
        const t = issueText(i)
        return (
          <Link key={i.key} href={t.href} className="mo-issue">
            <span className="mo-grow">
              <b>{t.title}</b>
              <small>{t.sub}</small>
            </span>
            <span className="link">Open</span>
          </Link>
        )
      })}
    </div>
  )
}

export function MonitoringClient({ data }: { data: AgencyMonitoring }) {
  const { customers, critical, warnings, totals } = data
  const withFeeds = customers.filter((c) => c.feeds > 0).length
  const critCustomers = customers.filter((c) => c.critical > 0).length

  return (
    <div className="ag mo">
      <header className="ag-head">
        <div>
          <h1>Monitoring</h1>
          <p className="ag-lede">Feed quality and the problems that need someone to act, across all customers. Start here in the morning instead of opening each customer.</p>
        </div>
      </header>

      <section className="card flush">
        <div className="ag-stats">
          <div>
            <span>Customers</span>
            <strong className="num">{formatNumber(totals.customers)}</strong>
            <small>{'{n} with feeds'.replace('{n}', formatNumber(withFeeds))}</small>
          </div>
          <div>
            <span>Feeds</span>
            <strong className="num">{formatNumber(totals.feeds)}</strong>
            <small>across customers</small>
          </div>
          <div>
            <span>Critical errors</span>
            <strong className={`num${totals.critical > 0 ? ' neg' : ''}`}>{formatNumber(totals.critical)}</strong>
            <small>{totals.critical === 0 ? 'Nothing is blocking a feed' : n1(critCustomers, 'for 1 customer', 'for {n} customers')}</small>
          </div>
          <div>
            <span>Quality</span>
            <strong className="num">{totals.quality === null ? '–' : pct(totals.quality)}</strong>
            <small>{totals.quality === null ? 'No feed checked yet' : 'checked products without problems'}</small>
          </div>
        </div>
      </section>

      {customers.length === 0 ? (
        <section className="card">
          <p className="ag-muted mo-empty">No customers yet. Create one on the Agency dashboard.</p>
        </section>
      ) : (
        <div className="mo-grid">
          <section className="card flush mo-quality">
            <div className="mo-h">
              <div>
                <h3>Feed quality</h3>
                <small>Share of checked products without errors or warnings. Worst first.</small>
              </div>
            </div>
            <div className="ag-tablewrap">
              <table className="ag-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th className="r">Feeds</th>
                    <th>Quality</th>
                    <th aria-label="Open" />
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link href={`/project/${c.id}`} className="ag-shop mo-shop">
                          <span className="ag-av">{initials(c.name)}</span>
                          <span>
                            <b>{c.name}</b>
                            {data.multipleAccounts && <small>{c.accountName}</small>}
                          </span>
                        </Link>
                      </td>
                      <td className="r num">{formatNumber(c.feeds)}</td>
                      <td className="mo-q">
                        {c.feeds === 0 ? (
                          <span className="ag-muted">No feeds yet</span>
                        ) : c.quality === null ? (
                          <span className="ag-muted">Not generated yet</span>
                        ) : (
                          <>
                            <span className={`num${c.quality < 0.8 ? ' neg' : ''}`}>{pct(c.quality)}</span>
                            <span className="mo-bar" aria-hidden="true">
                              <i style={{ width: `${Math.round(c.quality * 100)}%` }} />
                            </span>
                          </>
                        )}
                      </td>
                      <td className="r">
                        <Link href={`/project/${c.id}`} className="link">
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="mo-side">
            <section className="card">
              <div className="mo-h">
                <div>
                  <h3>Critical errors</h3>
                  <small>What stops a feed or a whole channel</small>
                </div>
                {critical.length > 0 && <span className="pill bad">{formatNumber(critical.length)}</span>}
              </div>
              {critical.length === 0 ? <p className="ag-muted mo-empty">Nothing critical right now. Every feed has synced recently and has no errors.</p> : <IssueList items={critical} />}
            </section>

            {warnings.length > 0 && (
              <section className="card">
                <div className="mo-h">
                  <div>
                    <h3>Warnings</h3>
                    <small>Not critical, but worth a look</small>
                  </div>
                </div>
                <IssueList items={warnings.slice(0, WARN_LIMIT)} />
                {warnings.length > WARN_LIMIT && (
                  <p className="ag-muted mo-more">{'+ {n} more'.replace('{n}', formatNumber(warnings.length - WARN_LIMIT))}</p>
                )}
              </section>
            )}
          </div>
        </div>
      )}

      <p className="ag-foot">Quality comes from each feed’s latest check of its first products. A product with two problems counts twice, so the figure errs low.</p>
    </div>
  )
}
