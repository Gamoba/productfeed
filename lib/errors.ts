// Centralised error handling so raw database / internal error text never leaks
// to the client (L1 hardening). The rule:
//
//   - Author-thrown, user-actionable messages → wrap in `AppError`. These are
//     safe and DO reach the client verbatim (e.g. "Projektet har ingen
//     Shopify-forbindelse", "Maks 5 godkendte eksempler").
//   - Everything else (Supabase/Postgres errors, unexpected exceptions) is
//     logged server-side and replaced with a generic message — schema names,
//     SQL, stack details never travel to the browser.
//
// `clientMessage` is the boundary used by server actions; `errorResponse` is the
// boundary used by API routes; `dbError` wraps a Supabase error result so the
// raw message is logged but not propagated.

const GENERIC_MESSAGE = 'An unexpected server error occurred. Try again later.'

// Marks an error whose message is safe and intended for the end user.
export class AppError extends Error {
  // Optional HTTP status for API routes (defaults to 400 — a client/domain issue).
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AppError'
    this.status = status
  }
}

// Returns a client-safe message for a caught error. AppError messages pass
// through; anything else is logged with context and genericised.
export function clientMessage(err: unknown, context: string): string {
  if (err instanceof AppError) return err.message
  console.error(`[error] ${context}:`, err)
  return GENERIC_MESSAGE
}

// API-route boundary: builds a Response that never leaks internals. AppError
// keeps its message + status; everything else logs and returns the generic 500.
export function errorResponse(err: unknown, context: string): Response {
  if (err instanceof AppError) {
    return Response.json({ error: err.message }, { status: err.status })
  }
  console.error(`[error] ${context}:`, err)
  return Response.json({ error: GENERIC_MESSAGE }, { status: 500 })
}

// Wraps a Supabase error result: logs the raw detail (code/message/hint) and
// throws a generic Error so the DB internals never reach the client. Use at
// every `if (error)` site that currently does `throw new Error(error.message)`.
export function dbError(context: string, error: { message: string; code?: string; hint?: string | null }): never {
  console.error(`[db] ${context}:`, error)
  throw new Error('The database operation failed')
}
