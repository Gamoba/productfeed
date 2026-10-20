// Read-only diagnostic: prints which Shopify access scopes each project's
// stored token actually has, checked against what the code needs.
//
// The main use is deciding whether a token has to be replaced. After changing
// the API scopes on the custom app in Shopify Admin, re-run this with the SAME
// stored token:
//   • new scopes show up  → the existing token picked them up, nothing to do
//   • they don't          → Shopify issued a new token; paste it via
//                           "Replace token" on /project/<projectId>
//
// Read-only in both directions: a single GraphQL *query* to Shopify (per
// AGENTS.md), and no writes to our own database. The token is decrypted in
// memory to sign the request and is never printed or logged.
//
// Run with:
//   npx tsx scripts/shopify-scopes.ts            # all connected projects
//   npx tsx scripts/shopify-scopes.ts coffee     # only projects matching "coffee"

import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decryptToken } from '../lib/crypto'
import { createShopifyClient } from '../lib/shopify'

const envFile = join(process.cwd(), '.env.local')
try {
  const lines = readFileSync(envFile, 'utf-8').split('\n')
  for (const line of lines) {
    const [key, ...rest] = line.split('=')
    if (key?.trim() && !key.startsWith('#')) {
      process.env[key.trim()] ??= rest.join('=').trim()
    }
  }
} catch {
  // fall through to existing env
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('Mangler DATABASE_URL i .env.local')
  process.exit(1)
}

// Every scope the code actually exercises, with the feature that breaks without
// it. Derived from the calls in lib/shopify.ts — keep in sync when new Shopify
// data is pulled in.
const REQUIRED_SCOPES: Array<{ handle: string; needed_for: string }> = [
  { handle: 'read_products', needed_for: 'produkt-sync, metafields, collections, markedspriser' },
  { handle: 'read_inventory', needed_for: 'inventoryItem.unitCost — COGS og margin' },
  { handle: 'read_markets', needed_for: 'markets-query — markeder i feed-wizarden' },
  { handle: 'read_locales', needed_for: 'shopLocales — sprogvalg pr. marked' },
  { handle: 'read_translations', needed_for: 'translations() — oversatte titler/beskrivelser' },
  { handle: 'read_metaobjects', needed_for: 'metaobject-referencer (region, drue, …) opløst til tekst' },
]

const filter = process.argv[2]?.trim().toLowerCase() ?? ''

const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1 })

type Row = {
  id: string
  name: string
  shop_url: string | null
  access_token_ciphertext: string | null
  access_token_iv: string | null
  access_token_tag: string | null
}

type ProbeBody = {
  data?: {
    shop?: { name?: string; myshopifyDomain?: string } | null
    currentAppInstallation?: { accessScopes?: Array<{ handle: string }> }
  }
  errors?: Array<{ message?: string }>
}

async function run() {
  try {
    const rows = await sql<Row[]>`
      SELECT id, name, shop_url,
             access_token_ciphertext, access_token_iv, access_token_tag
      FROM projects
      WHERE access_token_ciphertext IS NOT NULL
      ORDER BY created_at ASC
    `

    const projects = filter
      ? rows.filter(
          (p) =>
            p.name.toLowerCase().includes(filter) ||
            (p.shop_url ?? '').toLowerCase().includes(filter)
        )
      : rows

    if (projects.length === 0) {
      console.log(
        filter
          ? `\nIngen forbundne projects matcher "${filter}". Kendte: ${rows.map((r) => r.name).join(', ') || '(ingen)'}\n`
          : '\nIngen projects har en gemt Shopify-forbindelse.\n'
      )
      return
    }

    for (const p of projects) {
      console.log(`\n═══ ${p.name} — ${p.shop_url ?? 'ingen shop_url'} ${'═'.repeat(Math.max(0, 40 - p.name.length))}`)
      console.log(`    project id: ${p.id}`)

      if (!p.shop_url || !p.access_token_iv || !p.access_token_tag) {
        console.log('    → ufuldstændig forbindelse, springes over')
        continue
      }

      let token: string
      try {
        token = decryptToken({
          ciphertext: p.access_token_ciphertext!,
          iv: p.access_token_iv,
          tag: p.access_token_tag,
        })
      } catch {
        console.log('    → token kunne ikke dekrypteres (forkert TOKEN_ENCRYPTION_KEY?)')
        continue
      }

      let probe
      try {
        probe = await createShopifyClient({ shopUrl: p.shop_url, accessToken: token }).probeShopifyAccess()
      } catch (err) {
        console.log(`    → kunne ikke nå Shopify: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      let parsed: ProbeBody = {}
      try {
        parsed = JSON.parse(probe.rawBody) as ProbeBody
      } catch {
        // handled below — parsed stays empty
      }

      const ok = probe.httpStatus === 200 && !!parsed.data?.shop && !parsed.errors?.length
      console.log(`    HTTP ${probe.httpStatus} · API-version serveret: ${probe.apiVersionHeader ?? '—'}`)
      if (!ok) {
        const detail =
          parsed.errors?.[0]?.message ??
          (probe.httpStatus === 401 || probe.httpStatus === 403 ? 'access token afvist' : 'ukendt fejl')
        console.log(`    → tokenet virker ikke længere: ${detail}`)
        console.log('      Erstat det via "Replace token" på /project/' + p.id)
        continue
      }

      // Two independent sources: the installation query and the response header
      // Shopify sets on the same request. They normally agree; if they don't,
      // the header is the one the API enforced for this call.
      const granted = parsed.data?.currentAppInstallation?.accessScopes?.map((s) => s.handle) ?? []
      const headerScopes = (probe.grantedScopesHeader ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      console.log(`\n    Tildelte scopes (${granted.length}):`)
      for (const s of [...granted].sort()) console.log(`      ${s}`)
      if (headerScopes.length && headerScopes.slice().sort().join(',') !== granted.slice().sort().join(',')) {
        console.log(`    Header afviger: ${headerScopes.sort().join(', ')}`)
      }

      console.log('\n    Krævet af koden:')
      const missing: typeof REQUIRED_SCOPES = []
      for (const req of REQUIRED_SCOPES) {
        const has = granted.includes(req.handle)
        if (!has) missing.push(req)
        console.log(`      ${has ? '✓' : '✗'} ${req.handle.padEnd(18)} ${req.needed_for}`)
      }

      const extra = granted.filter((g) => !REQUIRED_SCOPES.some((r) => r.handle === g))
      if (extra.length) console.log(`\n    Ekstra (ubrugt af koden): ${extra.sort().join(', ')}`)

      const writeScopes = granted.filter((g) => g.startsWith('write_'))
      if (writeScopes.length) {
        console.log(
          `\n    ⚠ Write-scopes tildelt: ${writeScopes.sort().join(', ')} — koden skriver aldrig til Shopify (AGENTS.md), så de bør fjernes.`
        )
      }

      console.log(
        missing.length === 0
          ? '\n    → Alt på plads. Intet at gøre.'
          : `\n    → Mangler ${missing.length}: ${missing.map((m) => m.handle).join(', ')}`
      )
    }

    console.log('')
  } finally {
    await sql.end()
  }
}

run()
