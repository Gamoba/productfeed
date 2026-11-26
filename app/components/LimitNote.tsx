// An error note that, when a plan limit refused the action (lib/ops/limits.ts
// LimitError → `upgrade` in the response), also links to Billing.
export function LimitNote({ error, upgrade }: { error: string | null; upgrade?: string | null }) {
  if (!error) return null
  return (
    <p className="note warn" role="alert">
      {error}
      {upgrade && (
        <>
          {' '}
          <a href={upgrade} className="link">
            See plans
          </a>
        </>
      )}
    </p>
  )
}

// Reads `{ error, upgrade }` from a failed API response.
export async function readLimitError(res: Response): Promise<{ error: string; upgrade: string | null }> {
  const j = (await res.json().catch(() => ({}))) as { error?: string; upgrade?: string }
  return { error: j.error ?? `HTTP ${res.status}`, upgrade: typeof j.upgrade === 'string' ? j.upgrade : null }
}
