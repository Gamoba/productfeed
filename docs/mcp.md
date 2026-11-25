# FeedFlow MCP (Claude connector)

People in an agency can add FeedFlow to Claude as a connector and ask Claude
to read and change their feeds. One connection covers every shop the person
can open. FeedFlow never writes to Shopify through it.

## How it fits together

| Piece | Where |
|---|---|
| MCP endpoint (Streamable HTTP, stateless) | `app/api/mcp/route.ts` |
| Tools | `lib/mcp/server.ts` |
| Sign-in: Bearer token checked with Supabase | `lib/mcp/auth.ts` |
| Discovery metadata (RFC 9728) | `app/.well-known/oauth-protected-resource/` |
| Fallback for older clients: proxies Supabase's metadata | `app/.well-known/oauth-authorization-server/` |
| Consent page | `app/oauth/consent/` |
| Proposed changes, approval and auto-apply | `lib/mcp/changes.ts`, migration `057_mcp_changes.sql` |
| Shared save logic (UI and MCP run the same code) | `lib/ops/feedConfig.ts`, `lib/ops/masterFields.ts` and the rest of `lib/ops/` |
| Shop › API / MCP page | `app/project/[projectId]/api/` |

Supabase Auth is the OAuth 2.1 authorization server. Claude registers itself
(dynamic client registration) and sends the user to Supabase. Supabase sends
them to `/oauth/consent`, and after "Allow access" Claude gets a normal
Supabase access token for that user. Every tool starts from that user and uses
`getOwnedFeed` / `getOwnedProject`, the same checks as the UI.

## Tools

- **Read:**
  - `list_shops`, `get_feed`, `search_products`, `get_mapping`, `get_rules`
  - `get_performance`, `get_activity`, `list_changes`
  - `get_labels` (Google Ads labels with values, rules and product counts)
  - `list_title_buckets`, `get_title_bucket`, `list_title_review` (AI Titles)
  - `list_master_fields` (the shop's master fields and which feeds use them). Rules in `set_rules` may name `master:<key>` as their field.
- **Write, as proposals:**
  - `set_mapping`, `set_rules`, `set_feed_settings`
  - `set_label`, `set_label_bucket`: the label is recalculated once applied, as on the Labels page
  - `set_title_bucket`, `set_title_scope`, `set_title_instructions`
  - `set_master_field`, `delete_master_field`: shop-level changes (no feed), applied through `lib/ops/masterFields`; a delete is refused while a feed uses the field
  - `review_ai_titles`: approve, edit or reject titles in the review queue
  - `run_ai_titles`: at most 100 products per proposal, in chunks of 10 within the daily AI budget (`optimize_products_daily`), never overwriting titles edited by hand
- **Direct:**
  - `start_sync`: read-only towards the shop, at most once an hour per feed
  - `recalculate_labels`: re-applies the label rules to figures already fetched

Every write becomes a row in `mcp_changes`:
- **"Apply without approval" off** (`accounts.mcp_auto_apply`, the default): the row waits on Shop › API / MCP until a member approves or rejects it.
- **The setting on** (only owners and admins can switch it): the change applies at once.

Either way it is logged in the Activity log as "Name via Claude". The changes run
through `lib/ops` (`feedConfig.ts`, `labels.ts`, `titles.ts`), which call the same
libraries as the pages.

**Not exposed on purpose:**
- Shopify
- Shopify and Google Ads connections
- Users and roles
- Deleting anything: shops, feeds, labels, label values, AI Titles buckets

**Not built yet:**
- AI Titles example workshop (generating and grading example titles)
- Rule-based title rules per product type, and split-test custom labels on AI Titles buckets
- Product-level performance

## Setup (once per Supabase project)

1. **Run the migrations** 052–057 (`npm run migrate`). 057 adds `mcp_changes` and `accounts.mcp_auto_apply`.
2. **In the Supabase dashboard, under Authentication → OAuth Server:**
   - Turn on the OAuth server.
   - Set the authorization path to `/oauth/consent`. It is resolved against the project's Site URL, so the Site URL must be the app's real address.
   - Allow dynamic client registration, so Claude can register itself.
3. **Signing keys:** if Supabase asks for asymmetric JWT signing keys for the OAuth server, switch them on under Project Settings → JWT keys. The app checks tokens with `auth.getUser`, so it works with either kind.
4. **Connect from Claude:**
   1. Open Settings › Connectors › Add custom connector.
   2. Paste `https://<app>/api/mcp`.
   3. Choose Connect, then sign in and allow.

Until step 2 is done, `/.well-known/oauth-authorization-server` answers 502,
and Shop › API / MCP shows "sign-in for assistants is not switched on".

**Preview deployments:** the consent step always goes to the Site URL. A
preview can only be connected if the Site URL points at it, or once the code is
on the production address.
