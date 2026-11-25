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
  `master` keeps working on that schema in the meantime (trigger in 052).
- **Environment variables:** none new. The branch reads the same variables as
  `master`.
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
