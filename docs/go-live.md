# Going live

Production (rankclimbr.com) runs `master`. The new app is
`feed-tool-gennemgang-en` (English). Going live = merging it into `master`.
The Danish branch `feed-tool-gennemgang` is dropped (decided 2026-11-27).

The checklist below is in order. Each step says who does it: **code** is done
in a Claude session on the branch, **you** is a dashboard or a decision. The
reference section after it has the details the steps point to.

## The checklist

### 1. Finish the branch (code)

- [x] Commit what's open, and push the branch (27 Nov).
- [x] Security review of the open signup (decision A3), and its fixes
      (27 Nov; `docs/billing-status.md`, "Signup security"). Migration 068
      applied.
- [x] Test the two untested agency paths: an agency invite to someone with no
      login yet, and an agency with its own shops on a paid plan (27 Nov).
- [x] Test a downgrade through the customer portal (27 Nov): Advanced →
      Standard was scheduled for the period end (27 Dec), no refund invoice,
      the app keeps showing Advanced until then. Billing doesn't yet say
      that a change is scheduled.
- [x] Rename FeedFlow → Kompara in what people see (27 Nov): titles, brand,
      login/signup/invite/consent pages, app texts, the MCP connector's name
      and instructions, the Stripe product names `npm run stripe:setup`
      creates. Internal names (functions, CSS comments, price lookup keys
      `feedflow_<plan>_<interval>`) stay. Test-mode Stripe products keep
      their old names.
- [x] `npm run build` passes, with the Shopify read-only check (27 Nov).

### 2. Decide (you)

- [ ] **Stripe Managed Payments**: keep it (Stripe is the merchant of record
      and handles VAT; no tax registrations needed) or turn it off (then
      Stripe Tax needs Gamoba's registrations). See "Stripe and VAT" below.
- [ ] **Production address**: stay on rankclimbr.com, or move to kompara.io.
      Every URL below (Stripe webhook, Supabase redirects, Claude's OAuth)
      uses it, so decide first.
- [ ] `.claude/settings.local.json` is in git (allowed commands, no secrets):
      keep it, or take it out of git.

### 3. Stripe live mode (you)

- [ ] Account activated for live payments; business details and payout bank
      account filled in.
- [ ] The Managed Payments choice from step 2 set in live mode (and, if it's
      off: Stripe Tax on, origin address, tax registrations).
- [ ] Customer portal (live): card updates, invoices, cancelling, switching
      between the plans; upgrades "prorate and invoice immediately",
      **downgrades at the end of the period** (cheaper price and shorter
      interval). Test mode has this already (`bpc_1Ug1eCCKF2esnRoaAv9fR1RB`).
- [ ] Webhook endpoint `https://<production>/api/stripe/webhook` with the six
      events listed under "Stripe webhook" below. Copy its signing secret.
- [ ] A live secret key (`sk_live_…`), restricted to what the app uses if
      you prefer.

### 4. Vercel environment, Production (you)

- [ ] `STRIPE_SECRET_KEY` = the live key. Its prefix decides which billing
      rows the app reads and writes (`livemode`).
- [ ] `STRIPE_WEBHOOK_SECRET` = the live endpoint's signing secret.
- [ ] `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
      (Google today: `smtp.gmail.com`, `587`, `contact@kompara.io`, an app
      password, `Kompara <contact@kompara.io>`).
- [ ] `NEXT_PUBLIC_SALES_EMAIL` (optional): where Enterprise "Contact us"
      mails; the button is hidden without it.
- [ ] `TOKEN_ENCRYPTION_KEY`, the Supabase keys and `CRON_SECRET` already
      exist for `master`; check they're set for Production.

### 5. Supabase, Authentication (you)

- [ ] Site URL = the production address.
- [ ] Redirect URLs include `https://<production>/auth/invite`.
- [ ] Custom SMTP set (contact@kompara.io), and the "Invite user" template
      worded for signup ("Confirm your email and choose a password").
- [ ] "Allow new users to sign up" stays **off** (signup creates logins
      server-side).
- [ ] For Claude: OAuth server on, authorization path `/oauth/consent`,
      dynamic client registration allowed (`docs/mcp.md`).
- [ ] Database: nothing to run. Migrations 052–067 are already applied on the
      shared database (rollbacks in `supabase/rollback/`).

### 6. Clean up the test data (code, with you approving)

The database is shared with production, so test rows are real rows. Cancel
the Stripe **test** subscriptions first, then:

- [ ] Custom Plan Test ApS: `npx tsx scripts/test-signup-link.ts --cleanup custom-plan-test-1@example.com`
      (its two custom plans go with the account).
- [ ] Referral Client ApS: `--cleanup referral-test-1@example.com`; its
      referral, kickback rows and test payout.
- [ ] Test Agency (owned by kontakt@gamoba.dk): grants, referral code, payout.
- [ ] Gambora: `billing_exempt` back to `false`, and its shop "Gambora Shop
      (agency test)".
- [ ] The retired test add-on "Feed pack (test)".
- [ ] From the 27 Nov security tests: `--cleanup referral-consent-test@example.com`
      (Consent Test ApS) and `--cleanup agency-test-new@example.com`, then the
      agency account "New Login Agency (test)" and its referral link; Test
      Agency's test subscription (Standard monthly) and its shop "Agency Own
      Shop (test)".
- [ ] Not test data, keep: kontakt@gamoba.dk as platform admin, the default
      commission (20 %).

### 7. Merge and deploy (code, with your go-ahead)

```
git checkout master
git pull
git merge --ff-only feed-tool-gennemgang-en
git push
```

`--ff-only` refuses if `master` has moved on; then merge `master` into the
branch first, test, and try again. Vercel deploys `master`; the GitHub
workflow (scheduled syncs, Google Ads, SKU count) runs from `master` too.

### 8. Live setup after the deploy (you, in the app and Stripe)

With the live key in place:

- [ ] `npm run stripe:setup` with the live key: creates the plans' live
      products and prices and stores them in `plan_prices`.
- [ ] Admin (`/admin`): the default commission; the real add-ons (managed
      service, coaching, feed packs) with **both** a monthly and a yearly
      price; any custom plans again (test-mode ones don't carry over).
- [ ] Buy a plan once with a real card on a throwaway account, check
      Billing, the invoice and VAT, then refund and cancel it in Stripe.

### 9. Check production (you)

- [ ] Dashboard, a shop's Feeds page and a feed's Overview load.
- [ ] Save a mapping, an include/exclude rule and a setting on a test shop,
      and see them in the Activity log.
- [ ] The Google Ads page of a feed with an account shows figures.
- [ ] A feed link opens and shows XML; Merchant Center still fetches.
- [ ] The next GitHub workflow run succeeds (all three calls); the next day
      `shop_sku_usage` has a row per shop and Billing shows the figures.
- [ ] A few weeks on: search the Vercel logs for `[legacy-feed-url]`. When
      nothing shows, delete `/api/feed/[userId]` and `getFirstFeed`.

### If something is wrong

Vercel → Deployments → the previous production deployment → Promote / Instant
rollback. The database doesn't need rolling back: the old `master` code works
on the migrated schema.

## Reference

### What the merge brings

- **Vercel settings in `vercel.json`** (take effect with the merge):
  `regions: ["lhr1"]` (functions in London, next to the database in
  eu-west-2), and a Vercel Cron calling `/api/warm` every 3 minutes so a
  server is always warm (needs Pro; the project is on Pro).
- **Scheduled jobs:** `.github/workflows/cron-sync.yml` gains
  `/api/cron/google-ads` and `/api/cron/sku-usage` (the daily SKU count,
  which also bills last month's extra SKUs on the first tick of a month).
  They use the existing `vars.APP_URL` and `secrets.CRON_SECRET`.
- **Dependencies:** `@modelcontextprotocol/sdk` and `zod`; Vercel installs
  them on build.
- **Routes:** none removed. Merchant Center links
  (`/api/feed/generate/<feedId>`) keep working; the old `/api/feed/[userId]`
  stays until the logs show it's unused.

### Stripe webhook

Endpoint `https://<production>/api/stripe/webhook`, events:
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, `credit_note.created` (refunds, for agency kickbacks).

Locally (the CLI needs the events listed; keep the quotes in PowerShell):

    stripe listen --events "checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,credit_note.created" --forward-to localhost:3000/api/stripe/webhook

`stripe listen` prints its own signing secret; that one goes in `.env.local`
for local testing, not the Dashboard endpoint's.

### Stripe and VAT

The test account has **Managed Payments** on by default: Stripe acts as
merchant of record, works out and pays the VAT, and decides the payment
methods (card only today). That is why test invoices to a Danish address carry
25 % VAT although no tax registration exists. With it off, Stripe Tax computes
0 % until registrations are added; the app's `automatic_tax` (Checkout and
the extra-SKU invoices) needs no change either way. See
`docs/billing-status.md`, "Stripe Tax".

### Database load

Migration 067 indexes the read every heavy path does (`products` by feed,
status and created_at). If the database's CPU climbs after go-live, start at
Reports → Query Performance, check that `products` and `product_metafields`
have been analysed recently, and consider the compute size (PostgREST, Auth,
Storage and the log agent share it). `/api/feeds/counts` is only called per
shop and counts three feeds at a time.
