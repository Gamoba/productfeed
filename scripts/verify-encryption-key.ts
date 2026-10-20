// Verifies that TOKEN_ENCRYPTION_KEY in .env.local is the CORRECT key — not
// merely a well-formed one.
//
// Two levels of check:
//   1. Shape — does it base64-decode to exactly 32 bytes? (lib/crypto requires it)
//   2. Proof — does it actually decrypt the Shopify tokens already stored in the
//      database? AES-256-GCM authenticates on decrypt, so a wrong key fails the
//      auth tag rather than returning garbage. A successful decrypt is therefore
//      proof of the right key, not a guess.
//
// NEVER prints the key or any decrypted token. Only lengths, byte counts and
// pass/fail. Read-only: nothing is written anywhere.
//
// Run:  npx tsx scripts/verify-encryption-key.ts

import postgres from 'postgres'
import { readFileSync } from 'fs'
import { join } from 'path'
import { decryptToken, encryptToken } from '../lib/crypto'

const envFile = join(process.cwd(), '.env.local')
try {
  for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
    const [k, ...rest] = line.split('=')
    if (k?.trim() && !k.startsWith('#')) process.env[k.trim()] ??= rest.join('=').trim()
  }
} catch {
  // fall through to existing env
}

const raw = process.env.TOKEN_ENCRYPTION_KEY ?? ''

// Common paste damage, in the order worth trying. The leading '=' case is the
// one that happens when the whole `TOKEN_ENCRYPTION_KEY=…` line gets pasted
// after the '=' that is already in .env.local.
function candidates(v: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [{ label: 'as given', value: v }]
  const trimmedQuotes = v.replace(/^['"]|['"]$/g, '')
  if (trimmedQuotes !== v) out.push({ label: 'without quotes', value: trimmedQuotes })
  const noLeadingEq = trimmedQuotes.replace(/^=+/, '')
  if (noLeadingEq !== trimmedQuotes) out.push({ label: 'without leading "="', value: noLeadingEq })
  const noPrefix = noLeadingEq.replace(/^TOKEN_ENCRYPTION_KEY=?/, '')
  if (noPrefix !== noLeadingEq) out.push({ label: 'without variable name', value: noPrefix })
  const noSpace = noLeadingEq.replace(/\s+/g, '')
  if (noSpace !== noLeadingEq) out.push({ label: 'without whitespace', value: noSpace })
  return out
}

// Buffer.from(…, 'base64') silently ignores invalid characters, so length alone
// is not proof of a clean value — re-encode and compare to catch that.
//
// Padding and alphabet are normalised away first: a 43-char unpadded key and the
// 44-char padded form decode to the SAME 32 bytes, and base64url ('-','_') is
// equally valid. Comparing raw strings would flag those as corrupt when they are
// perfectly fine.
function inspect(v: string) {
  const buf = Buffer.from(v, 'base64')
  const canonical = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const roundTrips = canonical(buf.toString('base64')) === canonical(v)
  return { bytes: buf.length, roundTrips }
}

async function main() {
  console.log('\n── KEY SHAPE ─────────────────────────────────────────────')

  if (!raw) {
    console.log('✗ TOKEN_ENCRYPTION_KEY is empty in .env.local.')
    console.log('  Paste the value and run again. Expected: 44 characters, base64,')
    console.log('  ending with exactly one "=".')
    process.exit(1)
  }

  console.log(`  length        : ${raw.length} characters`)
  console.log(`  starts with = : ${raw.startsWith('=') ? 'YES (probably a mistake)' : 'no'}`)
  console.log(`  ends with =   : ${raw.endsWith('=') ? 'yes (expected for 32 bytes)' : 'NO'}`)

  let usable: string | null = null
  for (const c of candidates(raw)) {
    const { bytes, roundTrips } = inspect(c.value)
    const ok = bytes === 32
    console.log(
      `  ${c.label.padEnd(24)} → ${bytes} bytes${ok ? ' ✓' : ''}${
        ok && !roundTrips ? ' (but contains invalid characters)' : ''
      }`
    )
    if (ok && roundTrips && !usable) usable = c.value
    else if (ok && !usable) usable = c.value
  }

  if (!usable) {
    console.log('\n✗ No variant yields 32 bytes. The key is not usable.')
    console.log('  A correct key is 44 base64 characters and decodes to 32 bytes.')
    process.exit(1)
  }

  if (usable !== raw) {
    console.log('\n⚠ The value in .env.local is NOT usable as written,')
    console.log('  but a cleaned-up variant is. Fix the line in .env.local so it reads')
    console.log('  exactly:  TOKEN_ENCRYPTION_KEY=<44 characters>')
  }

  // Point lib/crypto at the usable variant for the remaining checks.
  process.env.TOKEN_ENCRYPTION_KEY = usable

  console.log('\n── ROUND TRIP (encrypt → decrypt) ────────────────────────')
  try {
    const probe = 'canary-' + '0'.repeat(20)
    const enc = encryptToken(probe)
    if (decryptToken(enc) !== probe) throw new Error('the value did not come back unchanged')
    console.log('  ✓ The key can encrypt and decrypt.')
  } catch (e) {
    console.log(`  ✗ ${e instanceof Error ? e.message : e}`)
    process.exit(1)
  }

  console.log('\n── PROOF: does it decrypt the EXISTING Shopify tokens? ───')
  const DATABASE_URL = process.env.DATABASE_URL
  if (!DATABASE_URL) {
    console.log('  (skipped — no DATABASE_URL)')
    console.log('\n  The shape is fine, but without this test it is not proven')
    console.log('  that it is the SAME key production uses.')
    return
  }

  const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1, connect_timeout: 15 })
  try {
    const rows = await sql<
      {
        name: string
        shop_url: string | null
        access_token_ciphertext: string | null
        access_token_iv: string | null
        access_token_tag: string | null
      }[]
    >`SELECT name, shop_url, access_token_ciphertext, access_token_iv, access_token_tag
      FROM projects WHERE access_token_ciphertext IS NOT NULL ORDER BY created_at`

    if (!rows.length) {
      console.log('  (no stored tokens to test against)')
      return
    }

    let ok = 0
    for (const r of rows) {
      try {
        const token = decryptToken({
          ciphertext: r.access_token_ciphertext!,
          iv: r.access_token_iv!,
          tag: r.access_token_tag!,
        })
        // Never print the token. The prefix check is a sanity signal only —
        // GCM's auth tag has already proven the key is right.
        const looksRight = /^shp(at|ca|ss)_/.test(token)
        console.log(
          `  ✓ ${r.name.padEnd(20)} ${(r.shop_url ?? '').padEnd(34)} ` +
            `decrypted (${token.length} chars${looksRight ? ', shopify format' : ''})`
        )
        ok++
      } catch {
        console.log(`  ✗ ${r.name.padEnd(20)} ${(r.shop_url ?? '').padEnd(34)} COULD NOT BE DECRYPTED`)
      }
    }

    console.log('')
    if (ok === rows.length) {
      console.log(`✓ ALL ${rows.length} tokens decrypted. This IS the correct key.`)
      console.log('  You can connect Google Ads now (remember to restart the dev server).')
    } else if (ok > 0) {
      console.log(`⚠ ${ok} of ${rows.length} decrypted — some rows are encrypted with a DIFFERENT key.`)
    } else {
      console.log('✗ No tokens could be decrypted. The key has the right SHAPE but is a DIFFERENT key')
      console.log('  from the one production data is encrypted with. Do not use it.')
      process.exitCode = 1
    }
  } finally {
    await sql.end({ timeout: 3 })
  }
}

main().catch((e) => {
  console.error('\n✗', e instanceof Error ? e.message : e)
  process.exit(1)
})
