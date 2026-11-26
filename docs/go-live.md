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
  Everything else is the same as `master`.
- **Billing setup (per Stripe mode):**
  1. Apply migration `061_billing_accounts.sql` (ask first; dry run:
     `npx tsx scripts/dryrun-061.mts`).
  2. `npm run stripe:setup` creates the plans' products and prices and stores
     their ids in `plan_prices`.
  3. Stripe → Webhooks: endpoint `https://<app>/api/stripe/webhook` with
     `checkout.session.completed`, `customer.subscription.created`,
     `customer.subscription.updated`, `customer.subscription.deleted` and
     `invoice.paid`. Locally (the CLI requires the events listed):
     `stripe listen --events "checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid" --forward-to localhost:3000/api/stripe/webhook`.
     Keep the quotes: in PowerShell, an unquoted comma list becomes an array
     and reaches the CLI as one space-separated (invalid) event name.
     `stripe listen` prints its own signing secret (`whsec_…`); that one goes
     in `.env.local` as `STRIPE_WEBHOOK_SECRET` for local testing, not the
     Dashboard endpoint's.
  4. Stripe → Tax: switch on Stripe Tax and set the origin address.
  5. Stripe → Customer portal: allow card updates, invoices, cancelling and
     switching between the FeedFlow plans.
  6. Supabase → Authentication: custom SMTP set up, and the "Invite user"
     email template worded for signup ("Confirm your email and choose a
     password"). "Allow new users to sign up" stays **off**: signup goes
     through `/signup`, which creates logins server-side.
  7. `platform_settings.default_commission_rate` set (e.g. `0.2` for 20 %).
     Until then referrals record a 0 % rate.
- **Routes:** no page or API route is removed. Feed links in Merchant Center
  (`/api/feed/generate/<feedId>`) keep working.
- **Scheduled jobs:** `.github/workflows/cron-sync.yml` gets a third step,
  `/api/cron/google-ads` (scheduled Google Ads fetch). GitHub runs workflows
  from `master`, so it starts with the merge. It uses the existing
  `vars.APP_URL` and `secrets.CRON_SECRET`.
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
- The next scheduled run of the GitHub workflow succeeds (all three calls).

## If something is wrong

Vercel → Deployments → the previous production deployment → Promote / Instant
rollback. The database does not need rolling back: the old `master` code works
on the migrated schema.
