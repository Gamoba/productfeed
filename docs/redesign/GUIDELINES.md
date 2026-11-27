# FeedFlow redesign: guidelines

This is the reference for the redesign work on branch `feed-tool-gennemgang`. It is based on two sources:

- **The review recording.** `gennemgang feed tool kompara.mp4`, about 17 minutes, in Danish. It walks through the prototype next to the current tool and next to DataFeedWatch. A raw transcript is in [gennemgang-transcript.txt](gennemgang-transcript.txt).
- **The prototype artifact.** "FeedFlow redesign" at https://claude.ai/artifact/YP7hRmnWCD23TYQkcsYyaY. It is a clickable prototype with example data: the shop "Bottles With History" and the agency "Gamoba".

When the recording and the prototype disagree, the recording wins: it is the later review of the prototype. Points the recording left unclear are listed in §8 as open questions. Don't guess on those; ask.

The project's hard rules still apply. Shopify is read-only. Credentials are per project and encrypted. See `AGENTS.md`.

---

## 1. Scope decisions from the review

| Area | Decision |
|---|---|
| Overall | Implement the prototype's design (Design B, "Kobolt" palette) in the feed tool. The prototype has more elements than the tool has today. |
| **CSS** (Comparison Shopping Service) | **Postponed.** It depends on a partner agreement that isn't in place. Ignore all CSS UI: the page, the CSS chips on Feeds, CSS merchants, CSS steps and CSS add-ons. |
| **Master fields** | **Built (Nov. 2026).** Shop-level fields with logic, set up once under Shop › Master fields and used from Mapping (the type “Master field”, or `master:<key>` as a source) and in include/exclude rules. Table `master_fields` (migration 058); evaluated in `lib/mappingEval`. |
| Agency level | Wanted. It is really just a login or account with several users (see §2). The name "Agency" is a placeholder. |
| Shop level | Corresponds to today's **Project** (one Shopify connection). |
| Feed level | Changes. Feeds were Google-only, one per language. Now a feed is **market (country) × channel** (see §3). |
| AI Titles | Works today. Restyle only; no change to the logic or to the levels. |
| Products, Overview, Include/exclude, Preview | Same data as today, laid out the new way, with the additions listed in §4. |
| Mapping | Same logic, plus **lookup tables** and **extra formatting** (§4). |
| Labels | Restyle, with specific removals (§4). |
| Performance / Campaigns / Wasted spend | The Google Ads connection and its data already exist. Rearrange them into the new layout. |

---

## 2. Hierarchy and navigation

There are three levels, and the sidebar changes with the level.

```
Agency (account/login, several users)
  └─ Shop  (= today's Project, one Shopify connection; shows its markets)
       └─ Feed  (market × channel, e.g. 🇩🇪 Google Shopping)
```

**Agency level**
- Shows every shop the account has access to, in one table. Columns: Kunde, Adgang, Land, Plan, Feeds, Fejl. Leave out the CSS column for now.
- Stats sit in one card: Kunder, Feeds i alt, Fejl der kræver handling.
- Clicking a customer row opens that shop.
- **Agency users.** The agency manages its own users and must be able to add them. The current tool can't do this yet.
- **Plan parameters** must be controllable somewhere, such as the number of users and the packages or plans. *How* is undecided, so build it so the limits can be configured, not hard-coded.
- Monitoring, Connected companies and Partner levels exist in the prototype but weren't discussed. Treat them as later work.

**Shop level** (sidebar: "← Alle kunder", Feeds, General performance, Værktøjer ▸, Konto ▸)
- There is a shop switcher at the top of the sidebar for moving between shops.
- **Feeds page:** one table with every feed, grouped by country or market. Each group row shows a flag, the country, the language, the product count in the shop, and **"+ Add new feed"**. A market with no feeds says "Ingen feeds i <land> endnu."
- **Add new feed:** choose the **channel type** (Google Shopping, Meta Catalog, Daisycon or Microsoft Ads) and connect it to a market. If the shop uses Shopify Markets, its markets are listed here.
- In the recording, the header button "Connect shop" was questioned on this page. The page's primary action is about feeds, not about connecting shops.
- **Per-country rules.** Some countries allow more channels or features than others; outside the EU, for example, there can be registration requirements. Build a rule table of channels or features × countries that can be extended later. Don't hard-code it in the UI.

**Feed level** (sidebar: "← Tilbage til shop", a feed card such as "🇩🇪 Google Shopping · Tysk · BWH", Overview, Products, **Opsætning ▸** Mapping / Inkludér / ekskludér / AI Titles / Labels / Preview & eksport, **Annoncer ▸** Performance / Campaigns / Wasted spend, Settings)
- The setup pages form a five-step flow. Each page ends with a step footer: "Trin X af 5 i opsætningen af feedet", a "Tilbage til …" button and a "Gem og videre til …" button.

**Global chrome**
- Breadcrumbs: `Gamoba › Shop › Page` at shop level, and `Shop › [🇩🇪 Google Shopping pill] › Page` at feed level.
- Top right: a feed status pill ("Feed kører", feed level only), plus search and notifications.
- **User menu:** the avatar must be clickable and open a user/account menu, like Supabase's.
- Below 820px the sidebar collapses to a top pill nav.

---

## 3. Feed model change

| Before | After |
|---|---|
| A feed was Google Shopping only, one per language. | A feed is **one channel in one market**. |
| Only one type of feed. | The channel type is chosen when the feed is created: Google Shopping, Meta Catalog, Daisycon or Microsoft Ads. More can come later. |

There are now two choices under the feed level: the **market** and the **channel**. Rules for which channels are allowed in which markets come from the per-country table in §2.

---

## 4. Page-by-page notes (feed level)

**Overview.** An alternative to today's feed page, showing the same data laid out differently:
- One stats card: Varer i feed, Felter mappet, Ekskluderet, Advarsler.
- The feed URL box with "Kopiér link".
- A "Fejl og advarsler" list. Each issue is a clickable row that links to the affected products or to the field in mapping.

**Products.** The same as today, "bare meget pænere":
- Rows expand into three columns: Titel (I shoppen / I feedet), Værdier i feedet, and Metafelter fra shoppen. This lets you see the mapping result for that product.
- Filters and sorting.
- A **"Sync again"** button. **Show when the feed last synced.**

**Mapping.** The same logic as today. Fields are grouped; the Required group is open and the other groups are collapsed. Each field row has an icon, the field name, a type select, tokens, "Preview" and "+ Rule". There are two additions:
1. **Lookup table.** Take a source value, match it against a table, and output the mapped value: "if it matches this, insert that value". DataFeedWatch was shown as the reference; it lets you supply the table as a CSV or Google Sheet URL.
2. **Extra formatting.** Formatting steps that manipulate the data further, both on the incoming source value and on the output, so you can transform the data after fetching it.

Also on Mapping:
- The "Labels" mapping type in the prototype is unclear. It may be a leftover, so leave it out unless someone confirms it.
- **Live preview** has two modes: "Ét felt" (one field across random products) and "Én vare" (all mappings for one chosen product). It must be expandable, because there is much more data than fits.

**Inkludér / ekskludér.** Rules plus how many products each rule takes out. The top segment shows the included and excluded counts.

**AI Titles.** Keep the current functionality and restyle it in the five-step stepper (Buckets → Scope → Teach → Run → Test). The rule is unchanged: "Du godkender altid, før noget går live."

**Labels**
- Buckets form a **funnel**. They are checked top-down and the first match wins ("Tjekkes oppefra. Første match vinder."). Keep the lookback window.
- **Remove the "Niveau" select** (Pr. vare / Pr. variant) from Labels. The level is already chosen in feed Settings, and Labels should **inherit** it.
- **Custom label 0–4** must be a selector at the top of the page.
- **Remove the "Budstrategi" POAS/ROAS toggle** from Labels. It is chosen elsewhere (see §8).

**Performance / Campaigns / Wasted spend.** The Google Ads connection and its data already exist, so this is presentation work only. In Wasted spend, check which rules apply before redesigning it.

**Settings** (applies to this feed only)
- Kilde
- Tidsplan: generate the feed and fetch performance, each with a frequency and a time. This is also where **Niveau** is set.
- Google Ads-konto, linked per feed, with a campaign filter.
- Konverteringsmål: Omsætning and Profit.
- Settings that used to live elsewhere move to this level.

---

## 5. Visual system (chosen: Design B + "Kobolt" palette)

The `feedflow-design` skill (`.claude/skills/feedflow-design/`) has been rewritten for this design. It is the authoritative, detailed version of this section and comes with reference screenshots. Load it before any UI work.

**Typography**
- `Outfit` (weights 300 to 600) everywhere, at a 14px base with line-height 1.45.
- No monospace in the UI. JetBrains Mono is only for code or XML blocks and API tokens.
- Headings use weight 500. The H1 is 24 to 30px. Big numbers are 28 to 34px at weight 400 with letter-spacing −0.02em.
- Numbers use tabular figures and Danish formatting: `2.786`, `21.940 kr.`, `1,42`, `+8 %`.

**Colour tokens**

| Token | Value | Use |
|---|---|---|
| canvas | `#f2eee8` | page background, warm off-white |
| canvas-line | `#ddd5c9` | |
| card | `#ffffff` | |
| card-2 | `#f5f2ec` | inner surfaces, hover, tracks |
| line | `#e7e1d7` | |
| text | `#101312` | |
| muted | `#69716e` | |
| **hi (Kobolt)** | `#2743d6` | highlight cards |
| hi-fg / hi-muted / hi-2 | `#fff` / `#c5cdf8` / `#3c57e6` | |
| **tint (peach)** | `#ffd9c4` on `#4a1f0a` | active nav item, selected bucket, soft emphasis, field icons |
| dark | `#16181f` | primary buttons, pressed segments and chips |
| accent-ink | `#2743d6` | links and focus ring |
| good / good-bg | `#1f7a55` / `#d3eedd` | |
| warn = bad / bg | `#b3261e` / `#f5d6d1` | **warnings are red everywhere** |

**Shape and space**
- Cards: 18px radius, 16px padding, a nearly flat shadow `0 1px 2px rgba(16,19,18,.05)`.
- Inner boxes 12px; inputs 10px.
- Buttons, pills, chips and segments are fully round.
- Content uses a 12-column grid with a 12px gap. The sidebar is 216px. The maximum width is 1440px.
- Motion: cards rise 10px over about 0.4s with a stagger. The drawer slides in over 0.28s. All motion is off under `prefers-reduced-motion`.

**Component rules**
1. **Show status as a dot plus text, not a coloured label.** "Klar", "Kilde OK" and "Aktiv" are a 7px green dot with muted text. Coloured pills are only for things that need action: "Mangler", "Afventer", "Kilde fejler".
2. **Colour belongs in the text.** Green means good and red means a warning, as in `+12` / `−3`, "4 advarsler" or "i går".
3. **Put numbers together in one card** with dividers, not one card per number. KPIs never go in the page header.
4. **Every page gets a header**: an H1, a one- or two-sentence lede that says what the page is for, and actions on the right with ghost buttons first and the primary button last.
5. **Kobolt `.hi` cards** are for the single most important highlighted card on a page, such as "Varer uden visninger" or a suggestions card. Inside one, the buttons and bars are peach. **Tint (peach) cards** are for soft emphasis.
6. **Use emoji flags instead of country codes.**
7. **Mapping fields show an icon plus the name.** Don't use black code labels.
8. **The selected bucket and the active nav item are tinted (peach).** Don't make them black.
9. **The sidebar shows red number badges**, not checkmarks. A collapsed group shows the sum of its badges.
10. **Tables:** no zebra striping; hairline rows; numbers right-aligned; clickable rows with a hover state and keyboard support; a row action link at the end ("Åbn feed", "Rediger").
11. **Lists of things to fix are clickable rows** that link to the place where the fix is made.
12. **Buttons:** primary is dark `#16181f`; ghost is outlined; `.link` is Kobolt text.

---

## 6. Copy and tone

- **English only.** The app goes live in English from `feed-tool-gennemgang-en` (decided 2026-11-27). The Danish branch `feed-tool-gennemgang` is dropped; changes are no longer ported to it.
- In the Danish UI, feature and page names stay in English where the prototype uses English (Overview, Products, Mapping, AI Titles, Labels, Settings).
- Keep it plain, short and direct. Address the user as "du" or "I/jeres".
- No exclamation marks and no marketing language. Use concrete numbers.
- Each page's lede says why the page exists. Subtitles explain the why, for example "Tjekkes oppefra. Første match vinder."
- Empty states say what to do next, for example "Ingen varer matcher. Ryd søgning og filtre for at se alle."

---

## 7. What not to build now

- CSS, anywhere.
- The agency pages Connected companies and Partner levels, the "Spørg Flow" AI chat, and the Design A and C variants.
- The prototype's leftover "Labels" mapping type, unless someone confirms it.
- Anything that writes to Shopify. Product actions such as "Ekskludér fra feed" and "Skriv titel selv" only change FeedFlow's own feed data.

- The **campaign filter** in Settings and the **Plan column** on the agency dashboard. Both are in the prototype, but skipped for now (Nov. 2026).

---

## 7a. Status (Nov. 2026)

**Built:** the app shell (sidebar per level, breadcrumbs with the feed switcher, the "Feed running" status pill, search on ⌘K / Ctrl+K and "Needs attention"), the Agency → Shop → Feed hierarchy, all feed pages from §4, the step footer on the five setup pages, the Mapping Live preview with "One field" and "One product", Master fields (shop level, used from Mapping and by Claude), agency Monitoring (feed quality per customer, critical errors, badge in the sidebar), flag emoji (with a font fallback on Windows) and the phone-width layout.

**Skipped for now:** the campaign filter in Settings and the Plan column on the agency dashboard (see §7).

**Still open:** the questions in §8.

---

## 8. Open questions (unclear in the recording)

1. **The POAS/ROAS toggle on Labels.** The recording says it should be removed because "det vælger man jo hernede", but it doesn't make clear where "hernede" is. It could be the Labels template setup ("Hvad byder I efter?") or the conversion goals in Settings.
2. ~~**Plan and user limits** at agency level.~~ **Answered (Nov. 2026).** They come from the plan the account subscribes to: `plans` holds the feed, shop, user and sync limits and the included SKUs, enforced in `lib/ops/limits.ts` for both the UI and Claude. Gamoba's platform admins keep the public plans, make custom plans per company, and keep the add-on catalogue that raises those limits (Admin). See `docs/billing-data-model.md`.
3. **The channel × country rule table.** What is the source of truth, and who keeps it up to date?
4. **"Labels" mapping type.** Drop it or keep it?
5. **Settings.** The recording refers to something "skubbet herind" from elsewhere, and to "Kali 2.0", which the transcription couldn't resolve. Confirm which settings move to feed level.
6. **The name for the "Agency" level.** It was described as a placeholder, with other words to come.
