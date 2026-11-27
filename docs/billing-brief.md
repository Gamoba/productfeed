# Billing with Stripe: brief

A brief for the session that builds subscriptions and billing with Stripe. Read it all before writing code.

**How to use it:**

1. Read §1–§3: the ground rules, the pricing and what the codebase already has.
2. **Ask Theis the questions in §4 before building anything.** Ask them in the order given, a group at a time, and offer the listed options; a recommendation is marked where there is one. Don't guess an answer: several of them decide the database design.
3. Write each answer into §5 (Decisions) as you get it, with the date. That makes this file the record of what was decided, for later sessions too.
4. Then plan the work from §6 and build.

---

## 1. Ground rules

- **Branch:** build on `feed-tool-gennemgang-en` (the English UI). It is merged into `master` when billing is done, which is the go-live as well (see `docs/go-live.md`). Whether the Danish branch `feed-tool-gennemgang` gets billing too is question A1. Until that is answered, change only the English branch, which is an exception to the "keep both branches in sync" rule in `AGENTS.md`.
- **Stripe test mode only:** use test keys (`sk_test_…`, `pk_test_…`) and test cards. No live keys until Theis switches them over.
- **One database for everything:** the preview deployments, local development and production all use the same Supabase database. Billing tables and test-mode Stripe data therefore land in the production database. Question F6 decides how test data is kept apart. Never write test subscriptions onto real customer accounts.
- **Migrations:** the next number is `061`. Follow the existing conventions:
  - idempotent SQL with a rollback file in `supabase/rollback/`;
  - a dry run in a transaction that is rolled back;
  - **ask Theis before applying to the database.** Additive changes only, so the app on `master` keeps working against the migrated database.
- **Shopify is read-only** (`AGENTS.md`). Billing never writes to Shopify.
- **Shared logic goes in `lib/ops/*`**, so the UI and the MCP tools (Claude) behave the same. A limit that blocks creating a feed in the UI must block it through Claude as well.
- **Secrets:** Stripe keys and the webhook secret are environment variables, read only on the server, never sent to the browser or logged. Name them in `docs/go-live.md` (it currently says "no new environment variables").
- **Way of working, from earlier sessions:**
  - Push only when `npm run build` succeeds.
  - Test against the Theis Test shop (`1cb71e48-a90a-44dd-bc0e-d35f78439177`), not customer shops.
  - Undo test changes afterwards.

## 2. The pricing (from Theis, Nov. 2026)

All prices in EUR, excluding VAT.

| Plan | Per month | Per year | SKUs included | Extra per 1,000 SKUs | Feeds | Shops | Users | Syncs per day |
|---|---|---|---|---|---|---|---|---|
| Standard | €49 | €490 | 1,000 | €3.80 | 3 | 1 | 1 | 1 |
| Advanced | €67 | €670 | 5,000 | €2.70 | 10 | 2 | 3 | 2 |
| Pro | €197 | €1,970 | 25,000 | €2.03 | 150 | unlimited | unlimited | 5 |
| Enterprise | quote | quote | custom | — | unlimited | unlimited | unlimited | 5 |

**The formula:**

- `monthly = plan price + ceil((SKUs − included) / 1000) × extra rate`, when SKUs exceed what's included.
- `annual = monthly × 10` (pay 10 months, get 12). The discount applies to extra SKUs too.

**Plan choice:** "the plan is chosen by SKU count". Above Pro's range the customer gets an individual quote (Enterprise).

**Included in every plan:**
- AI-generated titles and descriptions;
- AI product categorisation;
- unlimited feed rules and modifications;
- automatic feed validation.

**Differences between plans:**
- onboarding;
- support channels and response times;
- monitoring (validation only → plus email alerts → plus suggested fixes);
- extras:
  - Advanced: rule templates.
  - Pro: quarterly feed review, master rules across shops, MCC account support.

**Add-ons:** managed service, coaching, extra feeds in packs.

**Notes from the pricing itself:**
- The extra-SKU rates are estimates from competitor pricing, not confirmed figures.
- Onboarding, support, monitoring and extras are proposals, to be promised only if the team can deliver them.

**Check on the examples:** the formula gives these, but the pricing's examples say otherwise (see D3):

| SKUs | Plan | Monthly by formula | Annual by formula | Annual in the examples |
|---|---|---|---|---|
| 30,000 | Pro | €207.15 | €2,071.50 | €2,072 |
| 60,000 | Pro | €268.05 | €2,680.50 | €2,679 |
| 100,000 | Pro | €349.25 | €3,492.50 | €3,489 |

## 3. What the codebase has today

**Accounts and access:**
- `accounts` (migration 052): id, name, `seat_limit`, created_by. `seat_limit` already caps members, including invited ones (`lib/accountMembers.ts`).
- `account_members`: user_id, role (`owner` / `admin` / `member`).
- Helpers: `lib/accounts.ts` (`getMemberships`, `getAccountRole`, `getAccessibleProjectIds`).
- Pages: Agency dashboard (`/`), Monitoring, Agency users (`/agency/users`).

**Shops and feeds:**
- `projects` (shops) belong to an account (`projects.account_id`).
- `feeds` belong to a shop (`feeds.project_id`).
- A user reaches a shop or feed through account membership (`getOwnedFeed` / `getOwnedProject` in `lib/feeds.ts`).

**Products, and so SKUs:**
- `products` has one row per product **per feed** (`products.feed_id`), with `shopify_id`, `status` and the variants as JSON (`products.variants`).
- The same product therefore appears once for every feed of a shop. Counting SKUs means de-duplicating by shop and `shopify_id`, and counting variants out of the JSON if a SKU is a variant.
- `feed_counts` (migration 060) stores the last counted active and included products per feed, not per shop.

**Signup:**
- Self-service signup is **closed** (`app/login/actions.ts`). Accounts are created by an admin, and users join by invite (`app/auth/invite`).
- New customers (shops) are created from the Agency dashboard.

**Placeholder pages billing could use:**
- Shop level, in the sidebar's "Account" group (`shopNav` in `app/components/shell/nav.ts`):
  - `app/project/[projectId]/billing` ("Billing": add-ons, payment method, invoice details, invoices);
  - `company` ("Company settings": plan and limits, company details, address);
  - `access` ("Manage access");
  - `notifications`.
- Agency level: `app/agency/partner-levels` (Partner levels).
- These sit at **shop** level today, while the plans count shops and users per account (question B2).

**Limits in place today:**
- Seats (`accounts.seat_limit`).
- The daily AI title budget (`lib/rateLimit.ts`, `optimize_products_daily`: 20,000 products per day).
- Nothing limits feeds or shops.
- Sync schedule options are off / hourly / every 6 h / every 12 h / daily (`AUTO_SYNC_FREQUENCIES` in `lib/syncSchedule.ts`), set per feed. A GitHub Actions workflow ticks `/api/cron/sync` every 5 minutes, and it decides per feed.

**Features in the plans that don't exist yet:**
- AI descriptions (only AI titles);
- AI product categorisation;
- email alerts (no email sending in the app);
- suggested fixes;
- rule templates;
- master rules **across** shops (Master fields work within one shop);
- the guided setup wizard.

**Changes through Claude:**
- The MCP server (`lib/mcp/server.ts`, `docs/mcp.md`) can change mappings, rules, settings, labels, AI titles and master fields, as proposals.
- It can't create shops or feeds today.
- It can start AI title runs, within the daily budget.

**Infrastructure:**
- Vercel Pro, functions in London (`vercel.json`).
- English preview URL: `https://km-git-feed-tool-gennemgang-en-gamoba.vercel.app` (log in there separately).
- Open question §8.2 in `docs/redesign/GUIDELINES.md` ("Plan and user limits… where are they configured, and by whom?") is answered by this work. Update it.

## 4. Questions to ask Theis

Ask in this order. Options are suggestions; Theis can answer something else.

### A. Scope and rollout

**A1. The Danish branch.**
Billing is built on the English branch and merged into `master`. What happens to the Danish branch (`feed-tool-gennemgang`)?
- **(a)** English becomes the only version, and Danish is dropped.
- **(b)** Port billing to the Danish branch afterwards, as with earlier work.
- **(c)** Later, replace the two branches with one codebase that has translations.

**A2. Existing accounts when billing goes live.**
This covers the current production customer and Gamoba's own shops.
- **(a)** Keep them free (no subscription needed).
- **(b)** Give them a free period, then they must subscribe.
- **(c)** Put them on a plan by hand, invoiced outside Stripe.

**A3. How a new customer starts.**
- **(a) Recommended:** signup stays closed. Gamoba creates the account and sends a link to subscribe through Stripe Checkout.
- **(b)** Open signup: anyone can create an account and subscribe. Note: signup was closed on purpose, for security.

**A4. A trial.**
- Is there a free trial?
- How long?
- Is a card required up front?
- What happens when it ends without a subscription?

### B. Who pays

**B1. What a subscription belongs to.**
- **(a) Recommended:** the account (agency or company). The plan's shop, feed and user limits cover all of the account's shops.
- **(b)** Each shop separately.

For an agency like Gamoba with many customer shops: one subscription for the agency, or each end customer pays for its own shop?

**B2. Where Billing and Company settings live.**
- **(a) Recommended:** at account level (the agency sidebar).
- **(b)** Keep them at shop level, as the placeholders are today.

**B3. Who may change the plan, payment method and invoices.**
- **(a)** Owner only.
- **(b)** Owner and admins.

### C. What counts as a SKU

**C1. Product or variant?**
- Is a SKU a product, or each variant (size, colour)?
- On a variant feed, Google sees each variant as an item.

**C2. Active only?** Only active products, or all products in the shop?

**C3. Across which scope?**
- One count per shop, de-duplicated across the shop's feeds (a product in three feeds counts once)?
- Summed over all of the account's shops?

**C4. When is it measured?**
- **(a)** The current count at each billing date.
- **(b)** The highest daily count in the billing period.
- **(c)** The average.

**C5. Feed-URL shops.** Shops whose source is a feed URL instead of Shopify: same rules?

### D. Plans and prices

**D1. The SKU range of each plan.**
Where does each plan start and end? For example, with 4,000 SKUs:
- Standard: €49 + 3 × €3.80 = **€60.40**;
- or must it be Advanced, at €67?

What is the upper limit of Pro, above which it becomes Enterprise?

**D2. Choosing a higher plan.** Can a customer with few SKUs choose a higher plan for its shops, users, feeds or support?

**D3. Rounding.**
- **(a) Recommended:** bill exact cents (€207.15).
- **(b)** Round each month to whole euros.

Also: which numbers are right, the formula's or the examples' (§2)?

**D4. Annual billing with extra SKUs.**
- **(a)** Charge up front at the SKU count on the purchase date.
- **(b)** Charge up front, plus a top-up when the count grows during the year.
- **(c)** Charge the base annually and extra SKUs monthly.

**D5. Changing plans.**
- Upgrades: at once, with Stripe's proration for the rest of the period?
- Downgrades: at the end of the period, or at once?

**D6. Enterprise.**
- **(a) Recommended:** a "Contact us" form or link. Enterprise is invoiced by hand, or as a custom Stripe price Gamoba sets up.
- **(b)** Something in the app.

**D7. Add-ons** (managed service, coaching, extra feed packs): in Stripe now, or later?

### E. Limits and what happens at them

**E1. Exceeding a limit** on feeds, shops or users:
- **(a) Recommended:** block the action, with a message and an "Upgrade" button.
- **(b)** Allow it, but show a warning.
- **(c)** Allow it, and bill extra.

**E2. Syncs per day.** The plans say 1, 2 and 5 a day; the app offers hourly, every 6 h, every 12 h and daily. Map them. For example:
- Standard: daily only.
- Advanced: daily or every 12 h.
- Pro: also every 6 h.

Does the limit count scheduled syncs only, or "Sync now" as well?

**E3. Going above the plan's SKUs.**
- Billed by the formula automatically?
- Or must the customer move to the next plan once its range is passed?

**E4. Features in the plans that don't exist yet** (see §3). For each one:
- **(a)** Build it before launch.
- **(b)** Leave it out of the plan text until it exists.
- **(c)** Launch, and build it right after.

Is the existing Master fields feature (within one shop) "master rules" in the plan's sense, and so Pro-only? Or is it in every plan, with only "across shops" being Pro?

**E5. Claude (the MCP connector).** Is it in every plan, or only some?

**E6. When payment fails.**
- **(a) Recommended:** Stripe's automatic retries plus a grace period of N days with a banner. After that the app goes read-only, but **feeds keep being served**, so the customer's Merchant Center and ads keep running.
- **(b)** Stop serving the feeds after the grace period.

How many days of grace?

### F. Stripe, tax and invoices

**F1. The Stripe account.**
- Does one exist?
- Which company and country is it registered in?
- Is it in Stripe test mode for now, and who has access?

**F2. VAT.**
- Use Stripe Tax, collecting the customer's VAT number for reverse charge on EU B2B sales?
- Or handle VAT another way?

**F3. Payment methods.** Card only, or also SEPA Direct Debit, MobilePay or others?

**F4. Invoices and receipts.**
- Language (English or Danish)?
- Which company details are collected (name, address, VAT number, reference or att.)?
- Should invoices show in the app, or only in Stripe's customer portal?

**F5. Self-service management.** Use Stripe's hosted customer portal (change card, cancel, download invoices), or build it into the app?

**F6. Keeping test data apart in the shared database.**
- **(a)** Store Stripe's `livemode` flag on every billing row, and only ever act on rows that match the keys in use.
- **(b)** A separate Supabase project for billing tests.

The webhook on preview deployments: is Vercel's deployment protection on for previews? If so, Stripe can't reach the webhook there, and testing uses the Stripe CLI locally or a protection bypass.

## 5. Decisions

*(Fill in as Theis answers: question, answer, date.)*

| # | Decision | Date |
|---|---|---|
| A1 | Danish branch: port billing to `feed-tool-gennemgang` afterwards, as with earlier work. | 2026-11-26 |
| A2 | Existing accounts (the production customer and Gamoba's own shops) stay free, with no subscription needed. | 2026-11-26 |
| A3 | Open signup: anyone can create an account and subscribe. This reopens signup that was closed for security, so the signup path needs a security pass (abuse, email verification, rate limits). | 2026-11-26 |
| A4 | No free trial. | 2026-11-26 |
| — | Account model changed: MCC (agency) and User (paid) accounts, with access grants and referral kickbacks. See `docs/billing-data-model.md` for the model and its decisions. That covers B1–B3 and the old seat/role questions. | 2026-11-26 |
| C1 | A SKU is a variant. | 2026-11-26 |
| C2 | Only variants included in a feed count. | 2026-11-26 |
| C3 | Counted per feed, with no de-duplication across feeds, and summed over the account. | 2026-11-26 |
| C4 | Billed on the highest daily total in the billing period. | 2026-11-26 |
| C5 | Feed-URL shops follow the same rule. | 2026-11-26 |
| C1–C5 | **Settled 27 Nov 2026:** a SKU is an **item a feed sends out** — a product where the feed is set per product, a variant where it is set per variant — counted **once per shop** however many of its feeds send it, summed over the account, and billed on the highest daily total of the **calendar month**. Feed-URL shops the same. (C1 "a SKU is a variant" and C3 "per feed, no de-duplication" above are superseded: a shop pays for what its feeds really list.) | 2026-11-27 |
| E3 | No ceiling: extras are billed by the formula on every plan, however far above the included count. The Billing page says when another plan would be cheaper, and the customer chooses. | 2026-11-27 |
| D7 | Add-ons are built: a catalogue platform admins keep (Admin › Add-ons), with prices per interval, an optional quantity, and the limits one unit raises. Customers buy them on Billing; admins can also put one on an account, billed or free. | 2026-11-27 |
| — | Custom plans per account (made by platform admins), access by the User's code, and the kickback payout schedule: see `docs/billing-data-model.md`, decisions 23–26. | 2026-11-26 |
| — | Email: custom SMTP in Supabase. Signup creates logins server-side through the admin API (invite email), so Supabase's public signup stays off. | 2026-11-26 |
| — | First version: the User picks Standard, Advanced or Pro, monthly or yearly, and pays the base price. Extra SKUs come when the counting rule is settled. | 2026-11-26 |
| — | Extra SKUs and add-ons built (migration 066): a daily count per shop, billed monthly on the month's peak; add-ons on the plan's subscription. See `docs/billing-data-model.md`, decisions 28–31. | 2026-11-27 |
| F2 | VAT: Stripe Tax, with VAT ID collection at Checkout. | 2026-11-26 |
| F5 | Stripe's hosted Customer portal for card, invoices, plan changes and cancelling (chosen while building; revisit if needed). | 2026-11-26 |
| B3 | Owners and admins manage billing; members see it (chosen while building, as for member management; revisit if needed). | 2026-11-26 |
| E1 | At a plan limit (feeds, shops, users): the action is refused with the reason and a "See plans" link, in the app and through Claude. | 2026-11-26 |
| E2 | Syncs: Standard daily; Advanced also every 12 h; Pro and Enterprise also every 6 h; hourly only for free accounts or custom plans with 24+ a day. Only scheduled syncs count; "Sync now" doesn't. A schedule kept from before a downgrade runs at the plan's most frequent. | 2026-11-26 |
| E6 / gate | No plan yet: only Billing. Plan ended or unpaid: only Billing, showing the previous plan, Manage billing and Reactivate; feeds stop being served (HTTP 402) and syncs stop. Payment failed while Stripe still retries (past_due): full access with a notice (grace, chosen while building). Order syncs keep running for every account, since a gap in the 60-day order window can't be filled later. | 2026-11-26 |
| D4 | Annual plans: the base is paid yearly up front, and extra SKUs are billed monthly on each month's peak, at the annual rate (× 10 / 12). | 2026-11-26 |

## 6. Suggested build order (after the decisions)

1. **Data:** a migration for plans and subscriptions on the chosen owner (B1), with the Stripe customer and subscription ids, status, current plan, period end and `livemode` (F6). Dry run, then ask before applying.
2. **SKU count:** the counting function and where it's stored (C1–C5), checked against real numbers on the Theis Test shop and BWH.
3. **Stripe:** products and prices in test mode (monthly and annual, extra SKUs as usage-based or graduated pricing, D3–D4); Checkout to subscribe; the customer portal (F5).
4. **Webhook:** a signature-checked endpoint that keeps the subscription row in step (created, updated, payment failed, cancelled). It must be idempotent, since Stripe can send an event twice.
5. **Limits:** checks in `lib/ops` and the create-shop, create-feed, invite and schedule paths (E1–E3, E5), shared by the UI and Claude.
6. **Pages:** Billing and Company settings at the decided level (B2); a plan badge and upgrade prompts; the payment-failed banner (E6).
7. **Docs:** update `docs/go-live.md` (new environment variables, the Stripe webhook URL, switching to live keys), `GUIDELINES.md` §8.2, and this file's §5.
8. **Test** end to end in test mode:
   - subscribe, upgrade, downgrade, cancel;
   - a failed payment (Stripe test card 4000 0000 0000 0341);
   - the webhook replayed twice.
