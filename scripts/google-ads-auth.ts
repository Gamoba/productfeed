// One-off: mint a Google Ads API refresh token via the OAuth loopback flow.
//
// THROWAWAY / DIAGNOSTIC ONLY. It mints a token from the CLI so we can
// interrogate a real account before designing anything. The real product flow
// will use an /api/google-ads/callback route and store the refresh token
// AES-256-GCM-encrypted (same pattern as the Shopify token — see lib/crypto.ts
// / lib/projectShopify.ts). Nothing here survives into production.
//
// PREREQUISITE with a *Web* OAuth client: http://127.0.0.1:8765 must be listed
// under "Authorised redirect URIs" on the client, or Google returns
// redirect_uri_mismatch. (Desktop clients accept loopback with no registration.)
//
// TWO MODES — mode 2 exists because the browser redirect only succeeds if this
// process is still listening. If it has exited, Chrome shows ERR_CONNECTION_REFUSED
// but the ?code= is still sitting in the address bar, which is all we need.
//
//   1. npx tsx scripts/google-ads-auth.ts [login@gamoba.dk]
//        Starts a listener, prints the consent URL, completes automatically.
//
//   2. npx tsx scripts/google-ads-auth.ts --code "<paste the whole 127.0.0.1 URL>"
//        Completes a flow whose listener already died. Uses the PKCE verifier
//        stashed by the run that produced the URL.

import { createServer } from 'http'
import { randomBytes, createHash } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'

const envFile = join(process.cwd(), '.env.local')
try {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [k, ...rest] = line.split('=')
    if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
  }
} catch {
  // fall through to existing env
}

// Prefers the new Web client when present, else whatever legacy names are set.
// NB: a refresh token is bound to the client that minted it — google-ads-diagnose.ts
// resolves credentials the same way, so both scripts must agree.
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID / _SECRET (or CLIENT_ID / CLIENT_SECRET) in .env.local')
  process.exit(1)
}

const PORT = Number(process.env.GOOGLE_ADS_AUTH_PORT ?? 8765)
// Loopback redirect. A *desktop* client accepts this with no registration; a
// *web* client requires this EXACT string under "Authorised redirect URIs".
const REDIRECT_URI = `http://127.0.0.1:${PORT}`
const SCOPE = 'https://www.googleapis.com/auth/adwords'

// PKCE material is written here so mode 2 can finish a flow this process
// started. Temp dir, not the repo — it is short-lived secret-adjacent material.
const STATE_FILE = join(tmpdir(), 'google-ads-auth-state.json')

const b64url = (b: Buffer) => b.toString('base64url')

// ── Token exchange (shared by both modes) ────────────────────────────────────

async function exchange(code: string, verifier: string): Promise<Record<string, unknown>> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }).toString(),
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) throw new Error(`Token exchange ${res.status}: ${JSON.stringify(json)}`)
  return json
}

function report(tok: Record<string, unknown>) {
  const refresh = tok.refresh_token as string | undefined
  console.log('\n─────────────────────────────────────────────')
  if (refresh) {
    console.log('✓ Refresh token received. Put this line in .env.local:\n')
    console.log(`GOOGLE_ADS_REFRESH_TOKEN=${refresh}`)
    console.log('\nThen run:  npx tsx scripts/google-ads-diagnose.ts')
  } else {
    console.log('✗ No refresh_token in the response. That usually means the account')
    console.log('  has already authorised the app. Revoke access at')
    console.log('  https://myaccount.google.com/permissions and run again.')
    console.log(`\n  Response keys: ${Object.keys(tok).join(', ')}`)
  }
  console.log('─────────────────────────────────────────────\n')
}

// ── Mode 2: finish a flow whose listener already died ────────────────────────

const codeArgIdx = process.argv.indexOf('--code')
if (codeArgIdx !== -1) {
  const raw = process.argv[codeArgIdx + 1]
  if (!raw) {
    console.error('Usage: npx tsx scripts/google-ads-auth.ts --code "<the whole 127.0.0.1 URL>"')
    process.exit(1)
  }

  // Accepts either the whole redirect URL or a bare code. Going through
  // URLSearchParams also handles the percent-encoding in the code.
  let code = raw
  if (raw.includes('code=')) {
    const qs = raw.slice(raw.indexOf('?') + 1)
    const found = new URLSearchParams(qs).get('code')
    if (!found) {
      console.error('Could not find ?code= in the pasted URL.')
      process.exit(1)
    }
    code = found
  }

  let verifier: string
  try {
    verifier = JSON.parse(readFileSync(STATE_FILE, 'utf-8')).verifier as string
  } catch {
    console.error(
      `Could not read PKCE state from ${STATE_FILE}.\n` +
        'Run the script without --code first, complete consent, then try again.'
    )
    process.exit(1)
  }

  exchange(code, verifier)
    .then(report)
    .catch((e) => {
      console.error('\n✗', e instanceof Error ? e.message : e)
      console.error(
        '\n  invalid_grant usually means the code was already used or has expired' +
          ' (they last only a few minutes) — run the flow again.'
      )
      process.exit(1)
    })
} else {
  // ── Mode 1: listener ───────────────────────────────────────────────────────

  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))

  try {
    writeFileSync(STATE_FILE, JSON.stringify({ verifier, state }), 'utf-8')
  } catch {
    // Non-fatal: only mode 2 needs it.
  }

  const LOGIN_HINT = process.argv[2] ?? process.env.GOOGLE_ADS_LOGIN_HINT ?? ''

  const params: Record<string, string> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    // offline + consent together are what guarantee a refresh_token comes back.
    // Without prompt=consent Google omits it on re-authorisation.
    // select_account forces the account chooser — the browser's default Google
    // account is rarely the one with Google Ads access.
    access_type: 'offline',
    prompt: 'select_account consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }
  if (LOGIN_HINT) params.login_hint = LOGIN_HINT

  // URLSearchParams encodes spaces as "+", which some OAuth endpoints don't fold
  // back to a space — that would make prompt="select_account+consent" an invalid
  // value and silently drop the account chooser. Force %20. Safe for the other
  // params here: none of them can legitimately contain a "+".
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams(params).toString().replace(/\+/g, '%20')

  // NB: do NOT launch via `cmd /c start` on Windows — cmd.exe treats the `&`
  // between query parameters as a command separator, so the URL arrives at Google
  // truncated after client_id (symptom: "Required parameter is missing:
  // response_type"). rundll32 hands the string to the shell URL handler verbatim.
  function openBrowser(url: string) {
    try {
      if (process.platform === 'win32') {
        spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
      }
    } catch {
      // Browser launch is best-effort; the URL is printed regardless.
    }
  }

  const page = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:15px/1.6 system-ui;padding:60px;max-width:640px;margin:auto">` +
    `<h2>${title}</h2><p>${body}</p></body>`

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', REDIRECT_URI)
    const code = url.searchParams.get('code')
    const err = url.searchParams.get('error')
    const gotState = url.searchParams.get('state')

    if (!code && !err) {
      res.writeHead(404).end()
      return
    }

    if (err) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('Rejected', `Google returned: <code>${err}</code>`))
      console.error(`\n✗ Consent rejected: ${err}`)
      server.close()
      process.exit(1)
    }

    if (gotState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('State mismatch', 'Aborted for security reasons.'))
      console.error('\n✗ State mismatch — aborted')
      server.close()
      process.exit(1)
    }

    try {
      const tok = await exchange(code!, verifier)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('Done ✓', 'You can close this window and return to the terminal.'))
      report(tok)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page('Error', 'Token exchange failed — see the terminal.'))
      console.error('\n✗', e instanceof Error ? e.message : e)
    }

    server.close()
    setTimeout(() => process.exit(0), 100)
  })

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EADDRINUSE') {
      console.error(
        `\n✗ Port ${PORT} is already in use — probably an earlier attempt still running.\n` +
          `  Close that terminal, or choose another port:\n` +
          `    GOOGLE_ADS_AUTH_PORT=8766 npx tsx scripts/google-ads-auth.ts\n` +
          `  (remember to register http://127.0.0.1:8766 as a redirect URI)`
      )
    } else {
      console.error('\n✗ Server error:', e.message)
    }
    process.exit(1)
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nListening on ${REDIRECT_URI}  (15 min)`)
    console.log(`OAuth client:    ${CLIENT_ID!.split('-')[0]}-…`)
    console.log(`redirect_uri:    ${REDIRECT_URI}`)
    console.log('                 ^ this EXACT string must be listed under')
    console.log('                   "Authorised redirect URIs" on the client')
    if (LOGIN_HINT) console.log(`Suggested account: ${LOGIN_HINT}`)
    console.log('\nOpen this link (copy the whole line — it is long):\n')
    console.log(authUrl)
    console.log(
      '\nIf the browser lands on "127.0.0.1 refused to connect": that is fine.' +
        '\nCopy the whole URL from the address bar and run:' +
        '\n  npx tsx scripts/google-ads-auth.ts --code "<den URL>"\n'
    )
    openBrowser(authUrl)
  })

  // Don't leave a listener hanging forever if consent is abandoned.
  setTimeout(() => {
    console.error('\n✗ Timed out after 15 min with no response.')
    server.close()
    process.exit(1)
  }, 15 * 60 * 1000)
}
