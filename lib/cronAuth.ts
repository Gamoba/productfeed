import { timingSafeEqual } from 'crypto'

// Scheduled routes (/api/cron/*) are called by the GitHub Actions workflow
// with `Authorization: Bearer <CRON_SECRET>`. Constant-time compare, and fail
// closed when the secret isn't configured.
export function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  return got.length === want.length && timingSafeEqual(got, want)
}
