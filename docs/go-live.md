# Going live with the redesign

Production (rankclimbr.com) runs `master`. The redesign lives on two branches
with the same code and different UI language:

- `feed-tool-gennemgang` — Danish
- `feed-tool-gennemgang-en` — English

Going live = merging the chosen branch into `master`. The other branch is then
left as it is.

## State on 25 Nov 2026

- **Merge:** both branches contain all of `master`, so merging is a
  fast-forward: no conflicts, `master` becomes exactly the branch.
  If `master` gets new commits before then (the Google Ads work), merge `master`
  into the branch first, test, then merge the branch into `master`.
- **Database:** migrations 052–057 have already run on production (backup
  taken first, rollback script in `supabase/rollback/rollback_057_to_051.sql`).
  058 (master fields, a new table only) has run too; rollback in
  `supabase/rollback/rollback_058.sql`.
  `master` keeps working on that schema in the meantime (trigger in 052).
- **Vercel settings in `vercel.json` (take effect with the merge):**
  - `regions: ["lhr1"]`: functions run in London, next to the database
    (Supabase eu-west-2). The dashboard default is Frankfurt; the file wins.
  - A Vercel Cron calls `/api/warm` every 3 minutes, so a production server
    is always running (no cold start on the first click after a quiet
    spell). Needs the Pro plan (the project is on Pro). The product, order
    and Google Ads syncs are still ticked by `.github/workflows/cron-sync.yml`.
- **Environment variables (billing):** new, server-only unless noted:
  - `STRIPE_SECRET_KEY`: `sk_test_…` until go-live, then `sk_live_…`. The key's
    prefix decides which billing rows (`livemode`) the app reads and writes.
  - `STRIPE_WEBHOOK_SECRET`: the signing secret of the webhook endpoint below
    (test and live endpoints have different secrets).
  - `NEXT_PUBLIC_SALES_EMAIL` (public, optional): where the Enterprise
    "Contact us" button mails. Hidden when unset.
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`: the
    app's own emails (agency access requests, agency invites for existing
    logins), lib/email.ts. Today Google: `smtp.gmail.com`, `587`,
    `contact@kompara.io`, a Google app password, `Kompara <contact@kompara.io>`.
    Unset: no app email; everything also shows in the app.
  Everything else is the same as `master`.
- **Billing setup (per Stripe mode):**
  1. Apply migrations `061_billing_accounts.sql` to
     `066_sku_usage_and_addons.sql` (ask first; dry runs:
     `npx tsx scripts/dryrun-061.mts`, `…-063`, `…-064`, `…-065`, `…-066`).
     066 adds the daily SKU count, what was billed for extra SKUs, and the
     add-on catalogue.
  2. `npm run stripe:setup` creates the plans' products and prices and stores
     their ids in `plan_prices`.
  3. Stripe → Webhooks: endpoint `https://<app>/api/stripe/webhook` with
     `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted`,
     `invoice.paid` and `credit_note.created` (refunds, for agency
     kickbacks). Locally (the CLI requires the events listed):
     `stripe listen --events "checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,credit_note.created" --forward-to localhost:3000/api/stripe/webhook`.
     Keep the quotes: in PowerShell, an unquoted comma list becomes an array
     and reaches the CLI as one space-separated (invalid) event name.
     `stripe listen` prints its own signing secret (`whsec_…`); that one goes
     in `.env.local` as `STRIPE_WEBHOOK_SECRET` for local testing, not the
     Dashboard endpoint's.
  4. Stripe → Tax: switch on Stripe Tax, set the origin address, and **add
     the tax registrations** (Denmark, plus every country Gamoba is
     registered in). Without a registration Stripe Tax computes 0 % for
     everyone and invoices go out with no VAT — which is what the test
     account does today. `automatic_tax` is already on at Checkout and on the
     extra-SKU invoices, so this is configuration, not code.
  5. Stripe → Customer portal: allow card updates, invoices, cancelling and
     switching between the FeedFlow plans.
  6. Supabase → Authentication: custom SMTP set up, and the "Invite user"
     email template worded for signup ("Confirm your email and choose a
     password"). "Allow new users to sign up" stays **off**: signup goes
     through `/signup`, which creates logins server-side.
  7. Default commission set on the Admin page (`/admin`). Until then
     referrals record a 0 % rate.
  7b. Add-ons created on the Admin page, one per thing you sell (managed
     service, coaching, extra-feed packs), with a price for **both** intervals
     so monthly and yearly customers can buy them. The app creates the Stripe
     product and prices in the mode the keys are for, so the add-ons have to be
     created again after switching to live keys (as for custom plans).
  8. Platform admins: rows in `platform_admins` (today kontakt@gamoba.dk).
     They see Admin in the agency menu.
- **Routes:** no page or API route is removed. Feed links in Merchant Center
  (`/api/feed/generate/<feedId>`) keep working.
- **Database load:** migration 067 indexes the read every heavy path does
  (`products` by feed, status and created_at); without it each page of a
  catalogue read sorted the whole feed. If the database's CPU climbs after
  go-live, start at Reports → Query Performance, check that `products` and
  `product_metafields` have been analysed recently, and look at
  `/api/feeds/counts`, which still recounts every feed in parallel on each
  dashboard load.
- **Scheduled jobs:** `.github/workflows/cron-sync.yml` gets two more steps,
  `/api/cron/google-ads` (scheduled Google Ads fetch) and
  `/api/cron/sku-usage` (the daily SKU count, which also bills each paying
  account for last month's extra SKUs on the first tick after a month ends).
  GitHub runs workflows from `master`, so they start with the merge. They use
  the existing `vars.APP_URL` and `secrets.CRON_SECRET`.
- **Dependencies:** `@modelcontextprotocol/sdk` and `zod` are added; Vercel
  installs them on build.

## Before the merge

1. Decide the language, and merge that branch.
2. Supabase dashboard (Authentication):
   - Site URL is the production address.
   - Redirect URLs include `https://<production>/auth/invite` (invites).
   - For Claude: turn on the OAuth server, authorization path `/oauth/consent`,
     allow dynamic client registration (see `docs/mcp.md`).
3. Decide what to do with `.claude/settings.local.json`: the branches carry a
   change to it (allowed commands, no secrets). Keep it, or take the file out of
   git on `master` together.

## The merge

```
git checkout master
git pull
git merge --ff-only feed-tool-gennemgang      # or feed-tool-gennemgang-en
git push
```

`--ff-only` refuses if `master` has moved on, which is the signal to merge
`master` into the branch first.

## After the merge (on rankclimbr.com)

- Agency dashboard, a shop's Feeds page and a feed's Overview load.
- Save a mapping, an include/exclude rule and a setting on a test shop, and
  see them in the Activity log.
- The Google Ads page of a feed with an account shows figures and labels.
- Open a feed link in the browser and check the XML.
- The SKU count has run: `shop_sku_usage` has a row per shop for today, and a
  customer's Billing page shows the month's figures.
- The next scheduled run of the GitHub workflow succeeds (all three calls).

## If something is wrong

Vercel → Deployments → the previous production deployment → Promote / Instant
rollback. The database does not need rolling back: the old `master` code works
on the migrated schema.
