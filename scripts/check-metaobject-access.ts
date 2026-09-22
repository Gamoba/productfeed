// READ-ONLY diagnostic: why does a metaobject-reference metafield show a raw
// Shopify ID instead of its value?
//
// For every project it reports:
//   1. whether the stored access token has the `read_metaobjects` scope, and
//   2. what Shopify returns TODAY for GIDs we failed to resolve at sync time.
//
// Reading (1) and (2) together tells you which of the two causes you have:
//   - scope missing        → every metaobject reference in that shop stays a GID
//                            until the token is re-issued with the scope.
//   - scope present, but
//     GIDs resolve fine now → the lookup failed during that sync (cost ceiling /
//                            throttling). A re-sync clears it.
//
// Never prints an access token.
//
// Run: npx tsx scripts/check-metaobject-access.ts

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getProjectCredentials } from '../lib/projectShopify'
import { API_VERSION } from '../lib/shopify'

// tsx doesn't auto-load .env.local — same manual read as scripts/migrate.ts.
try {
  for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf-8').split('\n')) {
    const [k, ...rest] = line.split('=')
    if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
  }
} catch {
  // fall through to existing env vars
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const GID = 'gid://shopify/Metaobject/'
const SAMPLE_SIZE = 10

type Project = { id: string; name: string; shop_url: string }
type Feed = { id: string; name: string; project_id: string }
type MetafieldRow = { namespace: string; key: string; type: string; value: string }

function gidsIn(value: string): string[] {
  if (typeof value !== 'string') return []
  if (value.startsWith(GID)) return [value]
  try {
    const arr = JSON.parse(value)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string' && x.startsWith(GID)) : []
  } catch {
    return []
  }
}

async function shopifyQuery(
  shopUrl: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
) {
  const res = await fetch(`https://${shopUrl}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables }),
  })
  return { status: res.status, json: await res.json() }
}

async function run() {
  const { data: feeds } = await db.from('feeds').select('id, name, project_id')
  const { data: projects } = await db.from('projects').select('id, name, shop_url')

  for (const proj of (projects ?? []) as Project[]) {
    console.log(`\n=== ${proj.name} (${proj.shop_url}) ===`)

    let creds: { shopUrl: string; accessToken: string }
    try {
      creds = await getProjectCredentials(db, proj.id)
    } catch (err) {
      console.log(`  Kunne ikke dekryptere token: ${err}`)
      continue
    }

    // 1. Granted scopes.
    let hasScope = false
    try {
      const { status, json } = await shopifyQuery(
        creds.shopUrl,
        creds.accessToken,
        '{ currentAppInstallation { accessScopes { handle } } }'
      )
      const scopes: string[] = (json?.data?.currentAppInstallation?.accessScopes ?? []).map(
        (s: { handle: string }) => s.handle
      )
      hasScope = scopes.includes('read_metaobjects')
      console.log(`  HTTP ${status} — read_metaobjects: ${hasScope ? 'JA' : 'NEJ'}`)
      if (!hasScope) {
        console.log(`  scopes: ${scopes.join(', ') || '(ingen)'}`)
        console.log('  → Udsted tokenet igen MED read_metaobjects og forbind projektet på ny.')
      }
    } catch (err) {
      console.log(`  Scope-tjek fejlede: ${err}`)
      continue
    }

    // 2. Unresolved GIDs still stored for this project's feeds.
    const feedIds = (feeds ?? []).filter((f) => (f as Feed).project_id === proj.id).map((f) => f.id)
    if (feedIds.length === 0) {
      console.log('  Ingen feeds på projektet.')
      continue
    }
    const { data: rows } = await db
      .from('product_metafields')
      .select('namespace, key, type, value')
      .in('feed_id', feedIds)
      .like('value', `%${GID}%`)
      .limit(500)

    const sample: { label: string; gid: string }[] = []
    for (const r of (rows ?? []) as MetafieldRow[]) {
      for (const g of gidsIn(r.value)) {
        if (sample.length < SAMPLE_SIZE && !sample.some((s) => s.gid === g)) {
          sample.push({ label: `${r.namespace}.${r.key} [${r.type}]`, gid: g })
        }
      }
      if (sample.length >= SAMPLE_SIZE) break
    }

    if (sample.length === 0) {
      console.log('  Ingen uløste Metaobject-GIDer i databasen. ')
      continue
    }
    console.log(`  ${sample.length} uløste GIDer i databasen — slår dem op nu:`)

    if (!hasScope) {
      console.log('  (springer opslaget over — tokenet har ikke adgang)')
      for (const s of sample) console.log(`    BLOKERET  ${s.label}  ${s.gid}`)
      continue
    }

    const { json } = await shopifyQuery(
      creds.shopUrl,
      creds.accessToken,
      'query($ids: [ID!]!) { nodes(ids: $ids) { ... on Metaobject { id type displayName } } }',
      { ids: sample.map((s) => s.gid) }
    )
    if (json.errors) {
      console.log(`  GraphQL-fejl: ${JSON.stringify(json.errors[0]?.message ?? json.errors)}`)
      continue
    }
    const nodes = (json?.data?.nodes ?? []) as ({ id: string; type: string; displayName: string | null } | null)[]
    let ok = 0
    nodes.forEach((n, i) => {
      const s = sample[i]
      if (!n) {
        console.log(`    SLETTET?  ${s.label}  ${s.gid}`)
      } else {
        ok++
        console.log(`    OK        ${s.label}  ${n.type} → ${JSON.stringify(n.displayName)}`)
      }
    })
    if (ok > 0) {
      console.log(
        `  → ${ok}/${sample.length} kan slås op nu, men står som GID i databasen.` +
          ' Det er en synkronisering der fejlede — kør en ny sync på feedet.'
      )
    }
  }
}

run()
