# Billing, agencies and custom plans: status (2026-11-26)

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

## Built, not yet tested in the browser

- **Custom plans** (`lib/customPlans.ts`, Admin › Custom plans, migration
  065, applied): plan with own prices/limits for an existing account, or a
  one-time signup link (`/signup?plan=…`). Test: create one for a new company,
  sign up through the link with
  `npx tsx scripts/test-signup-link.ts <email> "<company>" --plan <token>`
  (the token is the part after `plan=`), pay, check Admin shows "Subscribed".

## Migrations applied to the shared database

061 billing tables · 062 cancel_at · 063 RLS everywhere · 064 MCC invite name ·
065 custom plan links. All have rollbacks in `supabase/rollback/`.

## Test data kept on purpose (shared DB = production too)

- **Gambora** (User account): temporarily `billing_exempt = true`; has the
  shop "Gambora Shop (agency test)".
- **Test Agency** (MCC): owned by kontakt@gamoba.dk, grants on Gambora and
  Referral Client ApS, referral code `w7vd5atm`, one test payout.
- **Referral Client ApS** (login referral-test-1@example.com): active Standard
  yearly Stripe *test* subscription, referral + commission rows.

Remove before go-live (cancel the Stripe test subscription first, then
`npx tsx scripts/test-signup-link.ts --cleanup referral-test-1@example.com`,
then Test Agency, then Gambora back to `billing_exempt = false`).

Not test data: default commission 20 %, kontakt@gamoba.dk as platform admin.

## Next

1. Test custom plans end to end (above).
2. Code review of the access rules (who can see which customer's data).
3. Account switcher (decision 14).
4. Untested paths: agency invite for a brand-new login, feed-only agency
   access, an agency with its own shops on a plan.
5. Open decisions: SKU counting (extra SKU billing waits on it), D1–D3, D5,
   D7, E4, E5, F3, F4 in the brief; kickback on prorated mid-year invoices.
6. Go-live: `docs/go-live.md` (Stripe live, Vercel env incl. SMTP, Supabase
   redirect URLs, rename FeedFlow → Kompara, Danish branch, remove test data).

## A new machine needs

`.env.local` is not in git. Besides the existing Supabase/Shopify variables it
needs `STRIPE_SECRET_KEY` (test), `STRIPE_WEBHOOK_SECRET` (the one
`stripe listen` prints) and the `SMTP_*` lines (`docs/go-live.md`). Then
`npm install`, and for webhooks:

    stripe listen --events "checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,credit_note.created" --forward-to localhost:3000/api/stripe/webhook
