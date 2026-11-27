# Billing, agencies, custom plans and add-ons: status (2026-11-27)

Where the work stands, for picking it up in a new session. The design is in
`docs/billing-data-model.md`, the decisions in `docs/billing-brief.md` §5, the
setup steps in `docs/go-live.md`.

## Built and tested (branch `feed-tool-gennemgang-en`)

- **Signup** (`/signup`, `lib/signup.ts`): server-side, through Supabase's
  invite email (custom SMTP: Google, `contact@kompara.io`). `?ref=` (agency
  referral) and `?plan=` (custom plan link).
- **Plans and payment** (`/billing`, `lib/billing.ts`, `/api/stripe/webhook`):
  Stripe Checkout with Stripe Tax + VAT ID, the customer portal, upgrade,
  cancel (`cancel_at`), failed payment (`past_due` = grace), reactivate.
- **Plan gate and limits** (`lib/entitlements.ts`, `lib/ops/limits.ts`): no
  plan or plan ended → only Billing, menu locked, feeds answer 402, syncs stop.
  Shop/feed/user/sync limits, shared with Claude.
- **Public data API closed** (migration 063): RLS on every table.
- **Agencies (MCC)** (`lib/mcc.ts`, `lib/mccAccess.ts`): admin invites,
  referral links, access codes with approve/decline/revoke, agency access to
  client shops in every lookup and list, the kickback ledger with yearly
  parts, refunds, payouts and overrides (`lib/commissions.ts`). Pages: Admin,
  Agency access, Connected companies, Partner levels.
- **Feed-scope grants** (decision 10, finished 2026-11-27): a client can give
  an agency one feed instead of the whole account. The shop then appears on
  the agency's dashboard marked "One feed", with no address and no shop
  actions, and the row opens the feed; the shop's own pages stay closed
  (`getOwnedProject` needs account scope). Checked end to end with a
  temporary grant, since no account uses feed scope today.

- **Custom plans** (`lib/customPlans.ts`, Admin › Custom plans, migration
  065; tested end to end 27 Nov): plan with own prices/limits for an existing
  account, or a one-time signup link (`/signup?plan=…`). Checked: link →
  signup (`scripts/test-signup-link.ts … --plan <token>`) → "Made for you" on
  Billing → Checkout → webhook → Admin "Subscribed", link marked used, limits
  applied. The form now also takes a price per 1,000 extra SKUs (per month,
  yearly pays 10/12; empty = extras free) — before that, a custom plan's SKU
  allowance was never charged above. Test company: Custom Plan Test ApS
  (custom-plan-test-1@example.com), monthly Stripe *test* subscription.

## Built, not yet tested in the browser

- **Add-ons** (migration 066; `lib/addons.ts`, Admin › Add-ons, Billing):
  catalogue kept by platform admins with prices per interval, an optional
  quantity and the limits one unit raises; bought by the account on Billing or
  put on by an admin, billed or free. Limits flow through
  `lib/entitlements.ts`, so Claude is held to them too. The tables are
  migrated and the code builds, but nothing has been bought through the UI
  yet, and **the catalogue is empty**: the add-ons you sell (managed service,
  coaching, feed packs) have to be created in Admin, with a price for both
  intervals, before a customer sees anything.

## Extra-SKU billing: built and tested end to end (2026-11-27)

`lib/skuMeasure.ts`, `lib/skuUsage.ts`, `lib/extraSkus.ts`,
`/api/cron/sku-usage`. A SKU is an item a feed sends out — a product in a
product-level feed, a variant in a variant-level one — counted once per shop
(decision settled 2026-11-27), summed over the account, billed monthly on the
month's highest day, with no ceiling on any plan. A monthly plan's extras ride
on its next invoice as a pending invoice item; a yearly plan's get an invoice
of their own, charged to the card on the plan.

What was checked against the real database and Stripe test mode:

- Counting through the app's own path: Theis Test → 11,290 SKUs. BWH's three
  feeds → 2,464 for the shop, where summing the feeds would say 7,224, so the
  de-duplication does real work. A feed with include/exclude rules goes
  through the app, a feed without one is counted in Postgres.
- A charge: Referral Client ApS (Standard yearly) with a faked 7,000-SKU
  October day → invoice DUIPLH0W-0004, €19.00 = 6 × 1,000 above the 1,000
  included at the yearly rate (€3.80 × 10 / 12), paid.
- The kickback: one part of €3.80 (20 %) payable 30 Nov — one, not twelve,
  because the extras invoice is monthly even though the plan is yearly.
  Replaying the event left the ledger at one row.
- A bug this found: a self-made invoice inherits neither the subscription's
  card nor the customer's, so it finalised and then could not be collected.
  Fixed (commit 8ec9d8b); the invoice now carries the plan's payment method.

Test it yourself with
`npx tsx --tsconfig tsconfig.json scripts/test-skus.ts` (count, measure, show,
charge, fake — the file's header explains each).

## Migrations applied to the shared database

061 billing tables · 062 cancel_at · 063 RLS everywhere · 064 MCC invite name ·
065 custom plan links · **066 SKU usage, charges and add-ons** (27 Nov) ·
**067 index on products (feed_id, status, created_at, id)** (27 Nov). All have
rollbacks in `supabase/rollback/`.

## Stripe Tax has no registrations

Found while testing: `stripe.tax.registrations.list()` is empty, so Stripe Tax
computes 0 % for everyone and the invoices so far carry no VAT at all —
including the subscription invoices, not just the extras one. Before go-live,
Stripe → Tax needs the Danish registration and any other country Gamoba is
registered in. The code is right (`automatic_tax` on, VAT ID collected at
Checkout); the account configuration is what's missing.

## Test data kept on purpose (shared DB = production too)

- **Gambora** (User account): temporarily `billing_exempt = true`; has the
  shop "Gambora Shop (agency test)".
- **Test Agency** (MCC): owned by kontakt@gamoba.dk, grants on Gambora and
  Referral Client ApS, referral code `w7vd5atm`, one test payout.
- **Referral Client ApS** (login referral-test-1@example.com): active Standard
  yearly Stripe *test* subscription, referral + commission rows.
- **Custom Plan Test ApS** (login custom-plan-test-1@example.com): custom plan
  "Enterprise – Custom Plan Test" with a monthly Stripe *test* subscription.
  Cancel it in Stripe, then `--cleanup` the login as below (the plan goes with
  the account).

Remove before go-live (cancel the Stripe test subscription first, then
`npx tsx scripts/test-signup-link.ts --cleanup referral-test-1@example.com`,
then Test Agency, then Gambora back to `billing_exempt = false`).

Not test data: default commission 20 %, kontakt@gamoba.dk as platform admin.

## Access rules: reviewed (27 Nov)

Who can see which customer's data. Every entry point that takes an id was
read: 47 API routes, 15 server-action files, 42 pages and the 28 MCP tools.
**No way was found for one customer's data to reach another.** Three checks
carry it, and everything goes through one of them:

- `getOwnedFeed` / `getOwnedProject` (`lib/feeds.ts`): membership of the
  owning account, or an agency grant, plus the account being usable.
- `getAccountRole` (`lib/accounts.ts`): real membership only — which is why an
  agency with whole-account access still can't touch the client's billing or
  users.
- `requirePlatformAdmin`: the Admin page and everything it does.

Worth knowing: 27 of the 28 MCP tools call the same two lookups before
anything else (the 28th, `list_shops`, starts from the user), member
management protects the last owner and the owner role, the Stripe webhook
checks its signature, and the crons need the bearer secret.

Two gaps were found — both access that didn't work, not access that leaked —
and both are fixed:

- Feed-scope grants led nowhere: honoured by `getOwnedFeed`, but listed in no
  dashboard, so the agency could only reach the feed by pasting its URL. Now
  listed (above).
- `/billing?account=…` for an account you don't manage silently showed your
  own instead. It now says whose plan it is and whose page you're looking at,
  naming the client only when you reach it through a grant.

Left as notes, not fixed:

- A client whose plan lapses disappears from its agency's dashboard with no
  explanation (`getUsableMemberships` filters locked accounts).
- `/api/feed/[userId]` still serves the user's oldest feed publicly — the
  pre-multi-feed compatibility route. Retire it once the Merchant Center URLs
  are on `/api/feed/generate/<feedId>`.

## Next

1. Stripe → Tax registrations (above). Nothing else on this list costs real
   money if it waits.
2. Create the real add-ons in Admin (managed service, coaching, feed packs)
   with a price for both intervals, then buy one on a subscribed account to
   see the proration and the raised limit.
4. Account switcher (decision 14).
5. Untested paths: agency invite for a brand-new login, an agency with its own
   shops on a plan. (Feed-only agency access was checked on 27 Nov.)
7. Open decisions: D1–D3, D5, E4, E5, F3, F4 in the brief; kickback on
   prorated mid-year invoices.
8. Go-live: `docs/go-live.md` (Stripe live, Vercel env incl. SMTP, Supabase
   redirect URLs, rename FeedFlow → Kompara, Danish branch, remove test data).
   The add-ons have to be created again under live keys, as custom plans do.

## Database load (27 Nov)

The database stopped answering for part of the day with its CPU pinned near
100 % for a week. What was found and done:

- `products` had no index for the read every heavy path does (feed_id +
  status, ordered by created_at). Migration 067 adds it: one page of the
  28k-product feed went from a sort over 28,705 rows at cost 10,332 to an
  index scan at 732.
- `product_metafields` (451,808 rows, 163 MB) had **never** been analysed —
  the planner believed it empty, and it sits in the embedded join of the most
  expensive query in the account. Both product tables are now vacuumed and
  analysed.
- The scheduled sync rebuilt the served XML on every run, even when the sync
  wrote nothing (2.2 s per cache write, plus a full catalogue read). It now
  rebuilds when the sync changed something or the stored XML is within an hour
  of its 6-hour expiry.
- Still open: query execution was only about an hour over 58 hours, which does
  not explain a pegged CPU on its own. If it stays high, look at the compute
  size — PostgREST, Auth, Storage and the log agent share that instance — and
  at `/api/feeds/counts`, which fans out an unbounded parallel recount of
  every feed on each dashboard load (751 ms per count).

## A new machine needs

`.env.local` is not in git. Besides the existing Supabase/Shopify variables it
needs `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` (the one
`stripe listen` prints) and the `SMTP_*` lines (`docs/go-live.md`). Then
`npm install`, and for webhooks:

    stripe listen --events "checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,credit_note.created" --forward-to localhost:3000/api/stripe/webhook
