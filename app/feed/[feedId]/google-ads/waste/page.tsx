import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getFeedSettings } from '@/lib/feedGoogleAds'
import {
  formatInt,
  formatMoney,
  formatPercent,
  getProductPerformance,
  resolveActions,
  type Window,
} from '@/lib/googleAdsAnalytics'
import { getStockForFeed, stockAgeDays } from '@/lib/inventoryAnalytics'
import { WasteTables, type WasteRow } from './WasteTables'
import './waste.css'

const WINDOWS: Window[] = [7, 14, 30, 90, 180, 365]
const DEFAULT_WINDOW: Window = 30

// Feed › Wasted spend. Spend on products that give nothing back: no revenue at
// all, revenue below the ad cost, or out of stock right now. A list to look at,
// not a list to act on blindly — the Forslag card points to where to act.
export default async function WastedSpendPage({
  params,
  searchParams,
}: {
  params: Promise<{ feedId: string }>
  searchParams: Promise<{
    days?: string
    roas?: string | string[]
    poas?: string | string[]
  }>
}) {
  const { feedId } = await params
  const { days: daysParam, roas: roasParam, poas: poasParam } = await searchParams

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const parsed = Number(daysParam)
  const days: Window = WINDOWS.includes(parsed as Window) ? (parsed as Window) : DEFAULT_WINDOW

  const asArray = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v])
  const hrefFor = (w: Window) => {
    const p = new URLSearchParams()
    p.set('days', String(w))
    for (const v of asArray(roasParam)) p.append('roas', v)
    for (const v of asArray(poasParam)) p.append('poas', v)
    return `/feed/${feedId}/google-ads/waste?${p.toString()}`
  }

  const db = adminDb()
  const settings = await getFeedSettings(db, feedId)
  const currency = settings?.currency_code ?? 'DKK'

  if (!settings?.customer_id) {
    return (
      <Shell days={days} hrefFor={hrefFor}>
        <Empty
          title="Feedet er ikke koblet til Google Ads"
          body="Rapporten læser det forbrug, Google har knyttet til varerne, så feedet skal have en forbindelse og mindst én synkronisering først."
          action={{ href: `/feed/${feedId}/google-ads`, label: 'Gå til Performance' }}
        />
      </Shell>
    )
  }

  const actions = resolveActions({ roas: roasParam, poas: poasParam }, settings)

  if (!actions.roas.length) {
    return (
      <Shell days={days} hrefFor={hrefFor}>
        <Empty
          title="Der er ikke valgt en konverteringshandling for omsætning"
          body="Spild er forbrug uden omsætning, så rapporten skal vide, hvilken handling der tæller som omsætning. Uden den ser alle varer ud, som om de intet har solgt."
          action={{ href: `/feed/${feedId}/google-ads?days=${days}`, label: 'Vælg den på Performance' }}
        />
      </Shell>
    )
  }

  const { rows, totals, from, to } = await getProductPerformance(db, feedId, days, actions)

  const matched = rows.filter((r) => !r.unmatched)
  const unmatchedCost = rows.filter((r) => r.unmatched).reduce((n, r) => n + r.cost, 0)

  const wasted = matched.filter((r) => r.cost > 0 && r.roas_conversions === 0).sort((a, b) => b.cost - a.cost)
  const wastedCost = wasted.reduce((n, r) => n + r.cost, 0)

  const losing = matched
    .filter((r) => r.roas_conversions > 0 && r.profitAfterAdSpend !== null && r.profitAfterAdSpend < 0)
    .sort((a, b) => (a.profitAfterAdSpend ?? 0) - (b.profitAfterAdSpend ?? 0))
  const losingCost = losing.reduce((n, r) => n + (r.profitAfterAdSpend ?? 0), 0)

  // ── Spend on products that cannot be shipped ──
  // FORWARD-LOOKING: stock is what it is NOW, the spend is the whole window. So
  // the claim is "this is spending on something that cannot be bought today",
  // never "this money was wasted".
  const stock = await getStockForFeed(db, feedId)
  const unavailable = matched
    .filter((r) => r.cost > 0)
    .map((r) => ({ row: r, stock: r.productRef ? stock.byProduct.get(r.productRef) : undefined }))
    // Only products whose stock is actually KNOWN and actually gone.
    .filter(({ stock: s }) => s !== undefined && s.outOfStock)
    .map(({ row }) => row)
    .sort((a, b) => b.cost - a.cost)
  const unavailableCost = unavailable.reduce((n, r) => n + r.cost, 0)

  const toRow = (r: (typeof rows)[number]): WasteRow => ({
    productRef: r.productRef,
    title: r.title,
    handle: r.handle,
    vendor: r.vendor,
    productType: r.productType,
    impressions: r.impressions,
    clicks: r.clicks,
    cost: r.cost,
    poasValue: r.poas_value,
    profitAfterAdSpend: r.profitAfterAdSpend,
    variantsTotal: r.productRef ? (stock.byProduct.get(r.productRef)?.variantsTotal ?? 0) : 0,
  })

  // Suggestions: where to act on what this page found. Links only — nothing
  // here changes the feed.
  const f = (p: string) => `/feed/${feedId}${p}`
  const suggestions: { text: string; href: string; cta: string }[] = []
  if (unavailable.length > 0)
    suggestions.push({
      text: `${formatInt(unavailable.length)} ${unavailable.length === 1 ? 'vare er' : 'varer er'} udsolgt, men får stadig budget. En regel om lager under 1 tager dem ud af feedet.`,
      href: f('/filters'),
      cta: 'Åbn Inkludér / ekskludér',
    })
  if (wasted.length > 0)
    suggestions.push({
      text: `${formatInt(wasted.length)} ${wasted.length === 1 ? 'vare har' : 'varer har'} brugt ${formatMoney(wastedCost, currency)} uden omsætning. Læg dem i en bucket med lavere bud.`,
      href: f('/google-ads/labels'),
      cta: 'Åbn Labels',
    })
  if (losing.length > 0)
    suggestions.push({
      text: `${formatInt(losing.length)} ${losing.length === 1 ? 'vare sælger' : 'varer sælger'} med tab efter annoncer. Se margin og break-even, før du skruer ned.`,
      href: f(`/google-ads?days=${days}`),
      cta: 'Åbn Performance',
    })

  return (
    <Shell days={days} hrefFor={hrefFor}>
      <p className="ws-def">
        Omsætning = {actions.roas.map((a) => `«${a}»`).join(' + ')}
        {actions.poas.length > 0 && <> · Bruttoprofit = {actions.poas.map((a) => `«${a}»`).join(' + ')}</>}
        {' · '}
        <Link href={`/feed/${feedId}/google-ads?days=${days}`} className="link">
          Skift på Performance
        </Link>
      </p>

      <div className="ws-top">
        <section className="card ws-stats">
          <div>
            <span>Forbrug uden omsætning</span>
            <strong className={`num${wastedCost > 0 ? ' neg' : ''}`}>{formatMoney(wastedCost, currency)}</strong>
            <small>de sidste {days} dage</small>
          </div>
          <div>
            <span>Varer</span>
            <strong className="num">{formatInt(wasted.length)}</strong>
            <small>med forbrug og ingen omsætning</small>
          </div>
          <div>
            <span>Andel af forbruget</span>
            <strong className="num">{totals.cost > 0 ? formatPercent(wastedCost / totals.cost) : '—'}</strong>
            <small>af {formatMoney(totals.cost, currency)} i alt</small>
          </div>
        </section>

        <section className="card hi ws-hi">
          <span className="ws-hi-l">Forslag</span>
          {suggestions.length === 0 ? (
            <p>Intet at gøre lige nu. Alle varer med forbrug har givet omsætning, og ingen er udsolgt.</p>
          ) : (
            <ul>
              {suggestions.map((s) => (
                <li key={s.href}>
                  <p>{s.text}</p>
                  <Link href={s.href} className="ws-cta">
                    {s.cta}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <WasteTables
        days={days}
        currency={currency}
        wasted={wasted.map(toRow)}
        wastedCost={wastedCost}
        losing={losing.map(toRow)}
        losingCost={losingCost}
        showLosing={actions.poas.length > 0}
        unavailable={unavailable.map(toRow)}
        unavailableCost={unavailableCost}
        stockSyncedAt={stock.syncedAt}
        stockAgeDays={stockAgeDays(stock.syncedAt)}
        wastedEmpty={
          <Empty
            title="Alle varer med forbrug har givet omsætning"
            body={`Intet har de sidste ${days} dage brugt budget uden at give noget tilbage. Vælg en længere periode for at se længere tilbage.`}
          />
        }
      />

      <div className="ws-notes">
        <p>
          {from} → {to}. Kun forbrug, Google kan knytte til en vare, er med. Performance Max-forbrug på placeringer uden
          vare tælles ikke, så tallene er lavere end kontoens samlede forbrug.
        </p>
        {actions.poas.length === 0 && (
          <p>
            Der er ikke valgt en handling for bruttoprofit, så varer der sælger med tab kan ikke findes, kun dem der
            slet ikke har givet omsætning.
          </p>
        )}
        {unmatchedCost > 0 && (
          <p className="neg">
            {formatMoney(unmatchedCost, currency)} kunne ikke knyttes til en vare i feedet og er ikke med i tallene.
          </p>
        )}
        <p>
          En vare uden konverteringer er ikke nødvendigvis en fejl. Den kan være ny, sæsonbetonet eller vise sig på
          søgninger, der konverterer et andet sted.
        </p>
      </div>
    </Shell>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Shell({
  days,
  hrefFor,
  children,
}: {
  days: Window
  hrefFor: (w: Window) => string
  children: React.ReactNode
}) {
  return (
    <div className="ws">
      <div className="ws-head">
        <div>
          <h1>Wasted spend</h1>
          <p className="ws-lede">
            Forbrug på varer, der ikke giver noget tilbage. En liste at se på, ikke at handle blindt på.
          </p>
        </div>
        <div className="ws-seg" role="group" aria-label="Periode">
          {WINDOWS.map((w) => (
            <Link key={w} href={hrefFor(w)} aria-current={w === days ? 'true' : undefined}>
              {w}d
            </Link>
          ))}
        </div>
      </div>
      {children}
    </div>
  )
}

function Empty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: { href: string; label: string }
}) {
  return (
    <section className="card ws-empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {action && (
        <Link href={action.href} className="wl-btn-primary">
          {action.label}
        </Link>
      )}
    </section>
  )
}
