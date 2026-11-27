<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:shopify-readonly-rule -->
# Redesign guidelines

UI and structure work for the redesign follows `docs/redesign/GUIDELINES.md`. It covers scope decisions (CSS and Master fields are postponed), the Agency → Shop → Feed hierarchy, page notes and the chosen visual system. Read it before redesign work.

- **English only.** The app goes live in English from `feed-tool-gennemgang-en` (decided 2026-11-27). The Danish branch `feed-tool-gennemgang` is dropped: don't port changes to it.
- **Feed changes go through `lib/ops/*`.** The UI and the MCP tools (Claude) share that code, so a rule added there applies to both. See `docs/mcp.md` for the MCP server and `docs/go-live.md` for the merge and release checklist.

# Shopify is strictly read-only — never write

This application must **NEVER** write to, update, or delete data in Shopify via the API. The rule applies for the entire lifetime of the project, regardless of how a feature request is framed.

**Forbidden:**
- GraphQL `mutation` operations (`productCreate`, `productUpdate`, `productDelete`, `productVariantUpdate`, `metafieldsSet`, `metafieldDelete`, `inventoryAdjustQuantities`, `bulkOperationRunMutation`, etc.)
- REST `POST` / `PUT` / `PATCH` / `DELETE` that mutate Shopify data
- "Temporary" or "debug-only" writes — also forbidden
- Webhooks that write back

**Allowed:**
- REST `GET`
- GraphQL `POST` to `/graphql.json` **only** when the body is a `query` (POST is just the protocol; what matters is the body)

If a feature request appears to require writing to Shopify, refuse it, point to this rule, and suggest a read-only alternative — or recommend a manual change via Shopify Admin.

This is enforced mechanically by `scripts/check-shopify-readonly.ts`, wired into `prebuild` so `npm run build` (and CI) fails on regressions.
<!-- END:shopify-readonly-rule -->

# Shopify credentials are per-project and encrypted

Each `project` row owns its own Shopify connection: `shop_url` plus an
AES-256-GCM-encrypted access token (`access_token_ciphertext` / `_iv` / `_tag`).
Credentials are **never** read from env at runtime and **never** stored in
plaintext.

- Build a Shopify client only via `createShopifyClientForProject(db, projectId)`
  (`lib/projectShopify.ts`), which decrypts the token with `TOKEN_ENCRYPTION_KEY`
  (`lib/crypto.ts`) at call time. `lib/shopify.ts` is a credentials-agnostic
  factory — do not make it read env.
- Decryption is server-side only. The plaintext token must never be sent to the
  client or logged. UI shows status + `shop_url` only; the token field is
  write-only (`POST /api/projects/[projectId]/connect`).
- Routes that talk to Shopify (`/api/shopify/markets`, `/api/shopify/products`,
  sync) require a `projectId`/feed whose project has a stored token, and fail
  with a clear error otherwise — there is no shared/global fallback.
- `SHOPIFY_SHOP_URL` / `SHOPIFY_ACCESS_TOKEN` in env are only consumed by the
  one-time backfill (`scripts/backfill-default-project.ts`), not by runtime.
