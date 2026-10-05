---
name: reisewarnungen-trip-check
description: >
  Give a plain-language travel-safety briefing for one or more countries using
  the reisewarnungen-cli (official Auswärtiges Amt advice). Trigger when the user
  asks "is it safe to travel to X?", "travel warning for Thailand?", "what does
  the Foreign Office say about Egypt?", "I'm going to Kenya and Tanzania, any
  warnings?", or wants the German government's current advice for a trip. Resolves
  country names to content ids, classifies the warning level — including advice
  against travel that no flag records — and distils the long HTML advisory into the
  parts a traveller acts on, not the raw JSON.
compatibility: >
  Requires the `reisewarnungen` CLI (npm package
  @maschinenlesbar.org/reisewarnungen-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  www.auswaertiges-amt.de.
---

# Reisewarnungen Trip Check

Turn a country name into a clear verdict — **full warning / regional warning / advice
only** — plus a short briefing pulled from the official Auswärtiges Amt advisory, instead
of handing back a 50 KB HTML blob.

## Tooling

This skill drives the `reisewarnungen` command. **Before anything else, validate it is available** — run `command -v reisewarnungen` (or `reisewarnungen --version`). If it is not on your PATH, STOP and inform the user that the `reisewarnungen` CLI (`@maschinenlesbar.org/reisewarnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

The CLI is read-only, needs **no API key**, and wraps the open Auswärtiges Amt travel-warning API. Always pass `--compact` so output is one line, easy to pipe into `jq`. Bump `--timeout 60000` if `get` (which fetches a large HTML body) times out. A country that doesn't exist makes `get` and `advice` exit **`4`** with `HTTP 404` — that means the id is wrong, not that the country is safe.

## Step 1 — Resolve the country to a content id

The user gives a name; `get` needs the numeric **content id**. Resolve it from
`countries`:

```bash
reisewarnungen countries --compact \
  | jq -r '.[] | select(.countryName == "Thailand") | [.id,.countryName,.countryCode,.iso3CountryCode,.warning,.partialWarning] | @tsv'
```

Notes and traps:
- **Country names are German** (`Ägypten`, `Vereinigtes Königreich`, `Russische Föderation`,
  `Côte d'Ivoire`), with exceptions: the United States is `USA`, not "Vereinigte
  Staaten". For an English request, match on `countryCode` (ISO-3166 alpha-2,
  e.g. `TH`) or `iso3CountryCode` (alpha-3, e.g. `THA`) instead — those are stable:
  `jq -r '.[] | select(.iso3CountryCode=="THA")'`. If a German exact match fails, fall
  back to a case-insensitive substring match, or to the ISO code.
- **Content ids are not ISO codes** and **can change** as the catalogue updates — always
  resolve fresh from `countries`, never hard-code one.
- Multiple countries (a multi-stop trip): resolve and brief each, then give a combined
  verdict.

## Step 2 — Read the warning flags (the verdict)

The four boolean flags on each `countries` entry give the level **without** fetching the
advisory. In increasing concern:

| Flag | Meaning | Verdict to report |
|---|---|---|
| `warning` | Full travel warning (Reisewarnung) — strongest "do not travel" | 🔴 **Full warning** |
| `partialWarning` | Regional warning (Teilreisewarnung) — applies to specific regions | 🟠 **Regional warning** |
| `situationWarning` | Situation-specific warning (event-driven) | 🟡 **Situation warning** |
| `situationPartWarning` | Situation-specific, limited to part of the country | 🟡 **Partial situation warning** |
| *(all false)*, advisory advises against or says to avoid travel to the country or a region (Step 3) | No formal warning, but advice against travel in the text | 🟡 **Advice against travel** (no formal warning) |
| *(all false)*, no such sentence (Step 3) | No formal warning, no advice against travel | 🟢 **Advice only** |

> **Quirk.** In current live data only `warning` and `partialWarning` are ever set;
> `situation*` flags exist in the schema but are presently all `false` across every
> country. Don't claim a situation warning unless the flag is actually `true`.

> **Trap — the flags don't carry advice against travel.** Below a formal warning, the
> Auswärtiges Amt advises against travel in the text alone, and in many phrasings, not
> only „abgeraten": „Von Reisen … wird dringend abgeraten", „Das Auswärtige Amt rät … ab",
> „Vermeiden Sie alle nicht zwingend erforderlichen Reisen in die o.g. Grenzgebiete"
> (Türkei), „Meiden Sie möglichst Reisen in die Provinzen …" (Angola), „Das Grenzgebiet
> zu Myanmar sollte, wenn möglich, weiträumig gemieden werden" (Bangladesch). No flag
> records any of them: Türkei, Angola, Bangladesch, Jordanien and Mexiko all have four
> `false` flags. So an all-false entry is **not** a verdict yet: always run Step 3 before
> saying 🟢.

A country counts as "warned" if **any** flag is true — that's exactly what
`countries --warned-only` filters on.

## Step 3 — Read the advice in the text (`advice`)

The flags give a 🔴/🟠 verdict on their own, but an all-false country needs the text
(see the trap above), and every briefing needs the regions it names. `advice` does the
extraction — don't grep the HTML yourself (a keyword list of your own will miss
phrasings, and full stops in „z. B." / „o.g." cut sentences):

```bash
reisewarnungen advice 201962 --compact \
  | jq -r '.sentences[] | select(.travel) | "[\(.section)] \(.text)"'
```

`advice` prints the flags, `effective`/`lastModified` and `sentences`: **every** sentence
of the advisory that warns or advises against something — „abgeraten", „rät … ab",
„gewarnt", „Reisewarnung", „meiden"/„vermeiden"/„gemieden"/„vermieden", „verzichten",
„unterlassen"/„unterbleiben", „aufgefordert", „nicht … reisen/aufsuchen/besuchen" — as
whole sentences, with the `section` (headings) they stand under. A sentence that
introduces a list („Von Reisen in folgende Regionen wird dringend abgeraten:") carries
the list's items. `travel: true` marks the sentences that also mention travel, a stay or
a part of the country.

**Classify (all-false countries):** read every `travel: true` sentence and ask: does it
advise against, or say to avoid, travel to (or stays in) the country or a named part of
it — a border area, province, region, city district? Then the verdict is 🟡 **Advice
against travel**, naming the regions. Sentences about crowds, demonstrations, night
driving, hiking, the sun, customs or vaccinations are not that — use them as bullets at
most. Only when **no** sentence advises against travel to the country or a region is 🟢
advice-only the answer. When in doubt, quote the sentence and say what it covers; never
drop it to reach 🟢. If `advice` fails (exit `1`/`4`), report the failure — never fall
back to 🟢.

For the rest of the briefing (entry rules, health, the full `Sicherheit` section) fetch
the whole advisory:

```bash
reisewarnungen get 201558 --compact
```

Fields on a `get` result that matter:

| Field | Meaning |
|---|---|
| `title` | e.g. `Thailand: Reise- und Sicherheitshinweise` |
| `warning` / `partialWarning` / … | same flags, authoritative for this country |
| `lastChanges` | German note on what changed last revision — **contains HTML tags**, strip them |
| `effective` | Unix timestamp **in seconds** (not ms — see trap) — when the current advice took effect |
| `lastModified` | Unix **seconds** — when the entry was last touched |
| `content` | The full advisory as **HTML** (often 40–60 KB) |
| `disclaimer` | Standard legal disclaimer — ignore for a briefing |

> **Traps.**
> - `get` results **do not carry an `id` field** (unlike `countries`/`list` entries) —
>   the id is the key you queried by, so remember it yourself.
> - `effective` / `lastModified` are Unix **seconds**, despite older docs saying
>   milliseconds. Multiply by 1000 before `new Date()` / don't divide. A value like
>   `1774615639` is March 2026, not 1970.
> - `content` is HTML, not text. Don't dump it raw. Extract the section headings
>   (`<h2>`/`<h3>`: `Aktuelles`, `Sicherheit`, `Terrorismus`, `Kriminalität`,
>   `Naturkatastrophen/Klima`, `Einreise`, `Gesundheit`) and summarise the
>   security-relevant ones.

## Step 4 — Brief the user

Lead with the verdict, then a short distilled summary — never the raw HTML.

```
Thailand 🟠 Regional warning (Teilreisewarnung)
Auswärtiges Amt, advice effective 6 Feb 2026; last change: editorial.

• Teilreisewarnung for the Thai–Cambodian border region and the deep south
  (Pattani, Yala, Narathiwat, Songkhla).
• Flight-traffic restrictions currently in effect (see "Aktuelles").
• Elsewhere: routine safety advice — petty crime, monsoon/flood season.

Full advisory: reisewarnungen get 201558   (German, HTML)
```

Rules:
- **Lead with the level** (🔴/🟠/🟡/🟢) and name the German term (Reisewarnung /
  Teilreisewarnung, or „rät ab" / „meiden" for 🟡 advice against travel) — that's the
  load-bearing fact.
- For a 🔴 full warning, say so plainly first ("Foreign Office advises against all travel
  to …") before any detail.
- Pull 3–6 bullets from the advisory's security sections (`Sicherheit`, `Aktuelles`,
  `Kriminalität`, `Terrorismus`) — the regions affected, the cause, any "currently"
  notices. Strip HTML tags from text you quote.
- Show **when the advice took effect** (`effective`, seconds → date) so the user knows
  it's current; surface `lastChanges` (tags stripped) if it's substantive.
- Multi-country trip: one verdict line per country, then combine ("of your three stops,
  Kenya carries a regional warning; the others are advice-only").
- Always note this is the **German** Foreign Office's advice (in German) and offer the
  `get <id>` command for the full text.
- Never soften or invent a level the flags don't support — and never read "all flags
  false" as "no data". It means there is no formal warning. If `advice` shows a sentence
  that advises against or says to avoid travel to the country or a region („abgeraten",
  „Vermeiden Sie … Reisen", „Meiden Sie möglichst Reisen …", „… sollte gemieden werden"),
  lead with 🟡 and that sentence's substance („Das Auswärtige Amt rät von Reisen in …
  ab" / "advises avoiding non-essential travel to …"), naming the regions, and don't call
  it a formal warning. Only when no such sentence exists is 🟢 advice-only the valid,
  reassuring answer.
