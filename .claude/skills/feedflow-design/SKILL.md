---
name: feedflow-design
description: >
  Visuelt designsprog for FeedFlow's UI (redesignet "Design B + Kobolt", valgt
  nov. 2026). Brug denne skill HVER gang du bygger, ændrer eller reviewer
  UI/styling i FeedFlow: sider, komponenter, kort, knapper, lister, tabeller,
  navigation, sidemenu, tomme tilstande og tekster i UI'et. Skill'en definerer
  tokens, app-skal, komponentregler og tone. Kig ALTID på skærmbillederne i
  references/ før du designer, og match dem. Trigger på enhver opgave der rører
  hvordan FeedFlow SER UD eller hvordan en side er bygget op.
---

# FeedFlow design-system (Design B + Kobolt)

Dette er FeedFlows designsprog. Det erstatter det tidligere system, som havde en lilla brand-farve og en mørk sidemenu. Kilden er prototypen "FeedFlow redesign" (https://claude.ai/artifact/YP7hRmnWCD23TYQkcsYyaY) og gennemgangen af den. Skærmbilleder af prototypen ligger i `references/`. Scope, sidehierarki og hvad der er udskudt står i `docs/redesign/GUIDELINES.md`. Læs den også, når du bygger en ny side.

> Rent UI og præsentation. Rør ALDRIG funktionel logik, data, routes, ownership, grounding eller migrationer i en design-opgave. Shopify er read-only (se `AGENTS.md`).

---

## Kerneprincipperne

1. **Varmt, roligt fundament.** Baggrunden er en varm offwhite (`#f2eee8`). Indholdet ligger på hvide kort med 18px radius og en næsten flad skygge. Der er ingen gradienter og ingen glød.
2. **Farve har en fast betydning.**
   - **Kobolt** (`#2743d6`) bruges til links og ét fremhævet kort pr. side.
   - **Fersken** (`#ffd9c4`) bruges til valgt eller aktivt: menupunkt, bucket, ikon-felter og bløde fremhævninger.
   - **Mørk** (`#16181f`) bruges til primærknapper og valgte segmenter.
   - **Grøn** betyder godt. **Rød** betyder advarsel eller fejl, også når det er "warning".
3. **Status er en prik og tekst.** "Klar", "Kilde OK" og "Aktiv" vises som en grøn prik med dæmpet tekst. Farvede pills bruges kun til ting, der kræver handling.
4. **Farven sidder i teksten.** Skriv `+12` med grønt og `−3`, "4 advarsler" eller "i går" med rødt. Farv ikke hele flader for at markere status.
5. **Tal samles i én kasse.** Nøgletal står i ét kort med lodrette skillelinjer, ikke ét kort pr. tal. Nøgletal står aldrig i sidehovedet.
6. **Hver side forklarer sig selv.** H1 og en lede på en eller to sætninger, der siger hvad siden er til. Undertitler siger hvorfor, fx "Tjekkes oppefra. Første match vinder."
7. **Lister med ting man kan klikke på.** Fejl og advarsler er klikbare rækker, der fører derhen, hvor man retter dem.

---

## Tokens

Læg dem på `:root`. Værdierne er de endelige efter alle runder i prototypen.

```css
:root{
  /* typografi */
  --font: "Outfit", "Avenir Next", "Segoe UI", system-ui, sans-serif;
  --code: "JetBrains Mono", ui-monospace, Menlo, monospace; /* KUN kode/XML og API-tokens */

  /* flader */
  --canvas:#f2eee8; --canvas-2:#e9e3da; --canvas-line:#ddd5c9;
  --on-canvas:#101312; --on-canvas-muted:#69716e;
  --chip:#ffffff; --chip-hover:#f6f8f7;
  --card:#ffffff; --card-2:#f5f2ec; --card-fg:#101312;
  --muted:#69716e; --line:#e7e1d7;

  /* fersken (blød fremhævning, valgt/aktiv) */
  --tint:#ffd9c4; --tint-fg:#4a1f0a;

  /* kobolt (kontrastkort + links) */
  --hi:#2743d6; --hi-fg:#ffffff; --hi-muted:#c5cdf8; --hi-2:#3c57e6; --hi-accent:#ffd9c4;
  --accent-ink:#2743d6;

  /* mørk (primærknap, valgte segmenter/chips) */
  --dark:#16181f; --dark-2:#262a36; --dark-fg:#f2f5f4; --dark-muted:#98a39f;

  /* status — advarsler er røde overalt */
  --good:#1f7a55; --good-bg:#d3eedd;
  --warn:#b3261e; --warn-bg:#f5d6d1;
  --bad:#b3261e;  --bad-bg:#f5d6d1;

  /* grafer */
  --series-1:#101312; --series-2:#ff9d6e; --series-3:#c79a2b; --series-4:#a9b3af; --series-5:#b3261e;

  /* form */
  --r-lg:18px; --r-md:12px; --r-sm:8px;
  --shadow:0 1px 2px rgba(16,19,18,.05);
}
```

**Kanalfarver** bruges kun i det lille kanal-ikon, et 22px afrundet felt med et hvidt bogstav:

| Kanal | Farve |
|---|---|
| Google | `#3b78e7` |
| Meta | `#0a66ff` |
| Daisycon | `#e2572b` |
| Microsoft | `#0f8a6a` |
| Klaviyo | `#232426` |
| PriceRunner | `#7a3fd1` |

---

## Typografi

- **Skrift:** `Outfit`, vægt 300 til 600, hentet fra Google Fonts. Grundteksten er 14px med line-height 1.45 og antialiased.
- **Ingen monospace i UI'et.** Feltnavne, tokens og værdier skrives med `--font`. JetBrains Mono bruges kun til XML- og kodeblokke og til API-tokens.
- **Størrelser:**

  | Element | Størrelse og vægt |
  |---|---|
  | H1 | 24 til 30px (clamp), vægt 500, `text-wrap: balance` |
  | Lede | 13px, dæmpet, maks 78ch |
  | Korttitel (H3) | 14px, vægt 500, med en undertitel på 12px dæmpet |
  | Store tal | 28 til 34px, vægt **400**, letter-spacing −0.02em, valgfri `<small>`-enhed |
  | Tabelhoved | 11px, vægt 500, dæmpet, letter-spacing 0.02em |
  | Sektionsetiket | 11px, uppercase, letter-spacing 0.08em, dæmpet, fx "LINK TIL FEEDET" |

- **Vægte:** brug 400 og 500. 600 bruges kun til badges, trin-numre og IF/THEN-nøgleord.
- **Tal:** brug `font-variant-numeric: tabular-nums` og dansk formatering: `2.786`, `21.940 kr.`, `1,42`, `+8 %`.

---

## App-skal

Strukturen er beskrevet i GUIDELINES §2. Her er den visuelle del.

- **Layout.**
  - Maks bredde 1440px, centreret. Sidepadding mindst 16px.
  - Grid: en sidemenu på 216px plus indhold, med 22px kolonneafstand.
  - Indholdet bruger et 12-kolonne grid med 12px gap.
- **Sidemenu.** Den ligger lyst på canvas og er sticky. Den mørke sidemenu fra det gamle design er udgået. Oppefra og ned:
  1. Brand: et lyn-ikon i en mørk cirkel og "FeedFlow".
  2. Shop-vælger: et hvidt kort med en 30px Kobolt-avatar med initialer, "Shop" over navnet og en chevron.
  3. Søgefelt: "Søg felt, vare, label ⌘K".
  4. Tilbage-link: dæmpet, fx "← Tilbage til shop".
  5. På feed-niveau: et feed-kort med flag, kanal og en undertekst, fx "Tysk · BWH · du er inde på dette feed".
  6. Navigation:
     - Links er 13px med en ikon foran og 10px radius.
     - **Aktivt menupunkt:** fersken-baggrund, `--tint-fg` og vægt 500.
     - **Grupper** (Opsætning, Annoncer, Værktøjer, Konto) folder ud med en chevron, der drejer 90°. Underpunkterne er rykket ind med en venstre hårlinje. En gruppe åbner automatisk, når en af dens sider er aktiv.
     - **Tal-mærker** er røde: 20px, `--warn-bg`/`--warn`, vægt 600. De bruges i stedet for flueben. En lukket gruppe viser summen af sine mærker.
  7. Bunden: et bruger-kort (avatar, navn, "Firma · Rolle"). Det skal kunne klikkes og åbne en brugermenu.
- **Topbar.**
  - Brødkrummer i 12.5px dæmpet, med den aktuelle side fed. På feed-niveau er feedet en pill-switcher: `Shop › [🇩🇪 Google Shopping] › Side`.
  - Til højre:
    - Statuspillen "Feed kører": fersken med en grøn prik. Den vises kun på feed-niveau.
    - Runde ikonknapper på 34px: søg og notifikationer.
    - Avatar.
- **Sidehoved.** H1 og lede til venstre. Handlinger til højre: ghost-knapper først, og den primære knap sidst.
- **Under 820px** skjules sidemenuen, og der vises en vandret pill-navigation øverst. Alle kort fylder 12 kolonner.

---

## Komponenter

**Kort**

| Variant | Udseende og brug |
|---|---|
| `card` | Hvid, 18px radius, 16px padding, `--shadow`, flex-kolonne med 12px gap. Kortets hoved har titel og undertitel til venstre og handlinger eller status til højre. |
| `card flush` | Ingen padding. Bruges til tabeller, der går fra kant til kant. |
| `card hi` (Kobolt) | `--hi`-baggrund med hvid tekst. Bruges til **ét** fremhævet kort pr. side, fx "Varer uden visninger", "Forslag" eller Bruttoprofit. Indeni er primærknappen fersken med Kobolt-tekst, barer er fersken på `--hi-2`, og links er fersken. |
| `card tint` (fersken) | Blød fremhævning, fx nuværende plan eller en grænse, der stadig er OK. |
| `card warnc` | Rød baggrund (`--warn-bg`). Bruges når en grænse er nået. |
| `note` | `--card-2`-baggrund, 12px radius, 12.5px tekst. `note warn` er rød, fx "Beskrivelse over 5.000 tegn". |

**Knapper**

| Variant | Udseende |
|---|---|
| Alle | Pilleform, 8px × 14px, 13px, vægt 500, valgfri ikon foran. Skalerer til 0.97, når der trykkes. |
| `btn-primary` | Mørk `#16181f` med lys tekst. |
| `btn-ghost` | Gennemsigtig med `--line`-kant. |
| `btn-sm` | 5px × 10px, 12px. |
| `link` | Kobolt-tekst, 12.5px, vægt 500, understreget ved hover. Bruges til "Åbn feed", "Rediger" og "Se varerne". |
| Deaktiveret | Opacity 0.4. |

**Status og etiketter**

| Komponent | Udseende og brug |
|---|---|
| `st` | En grøn prik på 7px og dæmpet tekst på 12px. Bruges til gode tilstande. |
| `pill` | 12px, 3px × 9px, rund. Varianter: `good`, `warn`/`bad` (rød), `dark` og `ai` (fersken). Bruges kun til det, der kræver handling: "Mangler", "Afventer", "Kilde fejler". |
| Rød tekst | Rød tekst med vægt 500 og uden pill, fx "Ekskluderet", "4 advarsler" eller en fejlcelle i en tabel. |
| `delta` | En lille pill med ↑/↓ på grøn eller rød baggrund. |

**Tal**

| Komponent | Udseende |
|---|---|
| `stats` | En række celler i ét kort. Hver celle har en dæmpet etiket, et stort tal (32px, vægt 400) og en underlinje på 12px. Cellerne er adskilt af lodrette hårlinjer og står to og to på mobil. |
| `bignum-row` | Etiket til venstre og et tal på 18px til højre, med en hårlinje imellem rækkerne. |

**Tabeller**
- Fuld bredde, 12.5px, hårlinjer mellem rækkerne og ingen zebrastriber. Celler har 10px × 12px padding.
- Tal er højrestillede.
- Første kolonne er typisk "vare/emne": et 34px thumbnail eller ikon, et fedt navn og en dæmpet linje under, fx "producent · id".
- Klikbare rækker har `--card-2` ved hover, `tabindex=0` og reagerer på Enter og Space. Rækken slutter med et `link`.
- Grupperækker, fx et land på Feeds, har `--card-2`-baggrund. De viser flag, land, sprog og antal produkter, og "+ Add new feed" til højre.
- Rækker kan folde ud til et detaljepanel med `--card-2`-baggrund og tre kolonner adskilt af lodrette linjer (se `feed_products.jpg`).
- Tomme resultater er centreret og dæmpet og siger, hvad man gør: "Ingen varer matcher. Ryd søgning og filtre for at se alle."
- Pager: "Vis [10/30/50/100] pr. side … Viser 1 til 10 af 2.786" med Forrige og Næste.

**Input og filtre**

| Komponent | Udseende |
|---|---|
| Input og select | Hvide, `--line`-kant, 10px radius, 12.5px. |
| Søgefelt | Rundt, med et forstørrelsesglas foran. |
| `chip` | En pill med kant og et tal med vægt 500 ved 0.7 opacity, fx "Alle 2.786". Valgt er mørk. |
| `seg` | Segmenteret kontrol på `--card-2`. Det valgte segment er mørkt. Bruges til fx 7d/14d/30d/90d og "Ét felt/Én vare". |
| Switch | 36×21, grøn når den er tændt, `role="switch"`. |

**Mapping-felter**
- Hver række viser et ikon-felt på 28px i fersken (efter felttype: #, T, link, pris osv.) og feltnavnet i 13.5px, vægt 500. Brug ikke sorte kode-labels.
- Kildefelter er fersken-tokens. Fast tekst er tokens i `--card-2`.
- Regler står under feltet med en venstre kant på 2px i `--series-2`. Linjerne er IF / THEN / ELSE, og nøgleordene er 11px, vægt 600 og spærret.
- Et felt der ikke er mappet, er dæmpet med et gråt ikon. Er feltet påkrævet, får det en "Mangler"-pill.

**Buckets og lister man vælger i**
- Den valgte bucket har **fersken** baggrund, ikke sort.
- Hver bucket har et rundt prioritetsnummer, et navn med feed-værdien under og et antal til højre.
- "+ Ny bucket" er stiplet.

**Stepper og trinfod**
- Trin er pills. Det aktuelle trin er Kobolt med et nummer i fersken. Færdige trin har ✓ i grønt på `--good-bg`.
- Opsætningssider slutter med et hvidt kort: "Trin X af 5 i opsætningen af feedet", "Tilbage til …" (ghost) og "Gem og videre til …" (primær).

**Fejl og advarsler**
- Rækkerne er klikbare. Hver række har et rødt ikon-felt, en fed titel med en dæmpet forklaring under og et link til højre, der fører til rettelsen.
- Under listen står en dæmpet linje om det, der er tjekket uden fejl.

**URL-boks:** et link-ikon, URL'en i 15px vægt 500, og "Kopiér link" (primær, lille), der skifter til "✓ Kopieret".

**Grafer:** linje- eller arealgrafer i SVG. Sammenligningsserien er stiplet, gitterlinjerne er svage (10 %), tekst er 10.5px dæmpet, og der er en prik for endepunktet. Små sparklines er 70×22. Donuts har stroke 13.

**Flag:** brug landeflag (emoji) i stedet for landekoder i mørke bokse.

**Bevægelse**
- Sider og kort glider ind fra 10px over 0.35 til 0.45s, forskudt med 0.04s.
- Linjer i grafer tegnes ind, og søjler vokser op.
- En skuffe glider ind fra højre over 0.28s med `cubic-bezier(.2,.8,.2,1)`.
- Alt slås fra under `prefers-reduced-motion`.
- Fokus: `outline: 2px solid var(--accent-ink); outline-offset: 2px`.

**Ikoner:** inline SVG på et 24px viewBox, stroke 1.7, runde ender, `currentColor`, typisk 13 til 16px.

---

## Tekst og tone

- **Sprog:** UI'et er på dansk. Feature- og sidenavne beholdes på engelsk, hvor prototypen gør det: Overview, Products, Mapping, AI Titles, Labels, Settings, Performance.
- **Stil:** kort, direkte og konkret. Tiltal brugeren som "du" eller "I/jeres". Ingen udråbstegn og intet marketingsprog. Brug rigtige tal.
- **Ledes og undertitler** forklarer formålet:
  - "Alle shoppens feeds på én liste, samlet pr. land."
  - "Klik for at rette"
  - "Du godkender altid, før noget går live."
- **Tomme tilstande** siger, hvad man gør nu, fx "Ingen feeds i Holland endnu." eller "Opret første feed".

---

## Tjekliste før du afslutter en flade

- [ ] Ligger siden på canvas med hvide kort (18px radius, næsten flad skygge)?
- [ ] Har siden H1 og en lede, og står handlingerne til højre med den primære knap sidst?
- [ ] Er status vist som prik og tekst, med farvede pills kun til det der kræver handling?
- [ ] Er rød brugt til alle advarsler og fejl, og sidder farven i teksten?
- [ ] Står nøgletallene samlet i ét kort med skillelinjer, og ikke i sidehovedet?
- [ ] Er der højst ét Kobolt-kort på siden, og er valgt/aktiv vist med fersken (ikke sort)?
- [ ] Er der ingen monospace uden for kode og XML?
- [ ] Er tal skrevet med dansk formatering og tabular figures?
- [ ] Kan klikbare rækker og lister bruges med tastaturet?
- [ ] Virker siden ved 820px og under?
- [ ] Matcher siden skærmbillederne i `references/`?
- [ ] Har du KUN rørt styling og markup, og ikke logik, data eller migrationer?

---

## Referencer (`references/`)

Skærmbillederne er taget fra prototypen under gennemgangen (nov. 2026).

| Fil | Viser |
|---|---|
| `shop_feeds.jpg` | Shop-niveau: feeds grupperet pr. land, prik-status, grønne og røde tal, "+ Add new feed". |
| `feed_overview.jpg` | Stats-kort med skillelinjer, URL-boks og listen "Fejl og advarsler". |
| `feed_products.jpg` | Filterlinje med chips og en udfoldet vare med tre kolonner og en rød note. |
| `feed_mapping.jpg` | Feltgrupper, felter med ikon og navn, IF/THEN/ELSE-regler og den sticky "Live preview". |
| `feed_include_exclude.jpg` | Den store segmentkontrol, regler, røde tal pr. regel, preview og trinfod. |
| `feed_labels.jpg` | Bucket-liste (valgt = fersken), regel-editor og trinfod. **NB:** "Budstrategi"-toggle og "Niveau"-select på denne side skal fjernes (GUIDELINES §4). |
| `feed_campaigns.jpg` | Tabel plus ét Kobolt-kort ("Varer uden visninger"). |
| `feed_settings.jpg` | Kort med `setrow`-rækker: etiket til venstre og kontrol til højre. |
| `agency_users.jpg` | Agency-niveau i sidemenuen, nøgletal og en brugertabel. |

Skærmbillederne er fra videoen. Prototypen kan have små senere rettelser, fx flag-emoji i stedet for "DE". Er du i tvivl, gælder tokens og regler i denne fil.
