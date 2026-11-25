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
  return i.country ? `${flagEmoji(i.country)} ${channel} i ${countryName(i.country)}` : `${channel} · ${i.feedName ?? ''}`
}

function issueText(i: MonitoringIssue): { title: string; sub: string; href: string } {
  const when = i.at ? ` · ${formatWhen(i.at)}` : ''
  switch (i.kind) {
    case 'connection':
      return { title: 'Shopify-forbindelsen fejler', sub: '{shop} · varer kan ikke hentes'.replace('{shop}', i.shopName), href: `/project/${i.shopId}/connections` }
    case 'feed_errors':
      return {
        title: `${feedLabel(i)}: ${n1(i.count, '1 fejl', '{n} fejl')}`,
        sub: [i.shopName, i.message].filter(Boolean).join(' · '),
        href: `/feed/${i.feedId}`,
      }
    case 'stale':
      return { title: `${feedLabel(i)}: ${'varer ikke synkroniseret i {d} dage'.replace('{d}', String(i.count))}`, sub: `${i.shopName}${when}`, href: `/feed/${i.feedId}/products` }
    case 'sync_failed':
      return {
        title: `${feedLabel(i)}: automatisk synkronisering fejlede`,
        sub: [i.shopName, i.message].filter(Boolean).join(' · ') + when,
        href: `/feed/${i.feedId}/settings`,
      }
    case 'feed_warnings':
      return {
        title: `${feedLabel(i)}: ${n1(i.count, '1 advarsel', '{n} advarsler')}`,
        sub: `${i.shopName} · ikke kritisk`,
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
            <span className="link">Åbn</span>
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
          <p className="ag-lede">Feed-kvalitet og det, der kræver handling, på tværs af alle kunder. Start her om morgenen i stedet for at åbne hver kunde.</p>
        </div>
      </header>

      <section className="card flush">
        <div className="ag-stats">
          <div>
            <span>Kunder</span>
            <strong className="num">{formatNumber(totals.customers)}</strong>
            <small>{'{n} med feeds'.replace('{n}', formatNumber(withFeeds))}</small>
          </div>
          <div>
            <span>Feeds</span>
            <strong className="num">{formatNumber(totals.feeds)}</strong>
            <small>på tværs af kunder</small>
          </div>
          <div>
            <span>Kritiske fejl</span>
            <strong className={`num${totals.critical > 0 ? ' neg' : ''}`}>{formatNumber(totals.critical)}</strong>
            <small>{totals.critical === 0 ? 'Intet stopper et feed' : n1(critCustomers, 'hos 1 kunde', 'hos {n} kunder')}</small>
          </div>
          <div>
            <span>Kvalitet</span>
            <strong className="num">{totals.quality === null ? '–' : pct(totals.quality)}</strong>
            <small>{totals.quality === null ? 'Intet feed tjekket endnu' : 'tjekkede varer uden problemer'}</small>
          </div>
        </div>
      </section>

      {customers.length === 0 ? (
        <section className="card">
          <p className="ag-muted mo-empty">Ingen kunder endnu. Opret en på Agency dashboard.</p>
        </section>
      ) : (
        <div className="mo-grid">
          <section className="card flush mo-quality">
            <div className="mo-h">
              <div>
                <h3>Feed-kvalitet</h3>
                <small>Andel af tjekkede varer uden fejl og advarsler. Dårligst først.</small>
              </div>
            </div>
            <div className="ag-tablewrap">
              <table className="ag-table">
                <thead>
                  <tr>
                    <th>Kunde</th>
                    <th className="r">Feeds</th>
                    <th>Kvalitet</th>
                    <th aria-label="Åbn" />
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
                          <span className="ag-muted">Ingen feeds endnu</span>
                        ) : c.quality === null ? (
                          <span className="ag-muted">Ikke genereret endnu</span>
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
                          Åbn
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
                  <h3>Kritiske fejl</h3>
                  <small>Det, der stopper et feed eller en hel kanal</small>
                </div>
                {critical.length > 0 && <span className="pill bad">{formatNumber(critical.length)}</span>}
              </div>
              {critical.length === 0 ? <p className="ag-muted mo-empty">Intet kritisk lige nu. Alle feeds er synkroniseret for nylig og har ingen fejl.</p> : <IssueList items={critical} />}
            </section>

            {warnings.length > 0 && (
              <section className="card">
                <div className="mo-h">
                  <div>
                    <h3>Advarsler</h3>
                    <small>Ikke kritiske, men værd at se på</small>
                  </div>
                </div>
                <IssueList items={warnings.slice(0, WARN_LIMIT)} />
                {warnings.length > WARN_LIMIT && (
                  <p className="ag-muted mo-more">{'+ {n} mere'.replace('{n}', formatNumber(warnings.length - WARN_LIMIT))}</p>
                )}
              </section>
            )}
          </div>
        </div>
      )}

      <p className="ag-foot">Kvaliteten kommer fra hvert feeds seneste tjek af de første varer. En vare med to problemer tælles to gange, så tallet er snarere for lavt end for højt.</p>
    </div>
  )
}
