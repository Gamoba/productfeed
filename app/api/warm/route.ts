// Keep-warm ping. Vercel Cron calls this every few minutes (vercel.json) so a
// production server is always running: after a quiet spell the first click
// otherwise waits ~1-3 s for a new server to start (a cold start). The routes
// share warm servers, so one ping keeps every page fast.
//
// Deliberately does nothing: no database, no login, no data in the answer.
// (The product, order and Google Ads syncs are ticked separately, by the
// GitHub Actions workflow in .github/workflows/cron-sync.yml.)
export const dynamic = 'force-dynamic'

export function GET() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
