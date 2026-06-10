---
name: reisewarnungen-trip-check
description: >
  Give a plain-language travel-safety briefing for one or more countries using
  the reisewarnungen-cli (official Auswärtiges Amt advice). Trigger when the user
  asks "is it safe to travel to X?", "travel warning for Thailand?", "what does
  the Foreign Office say about Egypt?", "I'm going to Kenya and Tanzania, any
  warnings?", or wants the German government's current advice for a trip. Resolves
  country names to content ids, classifies the warning level, and distils the long
  HTML advisory into the parts a traveller acts on — not the raw JSON.
version: 1.0.0
userInvocable: true
---

# Reisewarnungen Trip Check

Turn a country name into a clear verdict — **full warning / regional warning / advice
only** — plus a short briefing pulled from the official Auswärtiges Amt advisory, instead
of handing back a 50 KB HTML blob.

## Tooling

This skill drives the `reisewarnungen` command. **Before anything else, validate it is available** — run `command -v reisewarnungen` (or `reisewarnungen --version`). If it is not on your PATH, STOP and inform the user that the `reisewarnungen` CLI (`@maschinenlesbar.org/reisewarnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The CLI is read-only, needs **no API key**, and wraps the open Auswärtiges Amt travel-warning API. Always pass `--compact` so output is one line, easy to pipe into `jq`. Bump `--timeout 60000` if `get` (which fetches a large HTML body) times out. A country that doesn't exist makes `get` exit **`4`** with `HTTP 404` — that means the id is wrong, not that the country is safe.

## Step 1 — Resolve the country to a content id

The user gives a name; `get` needs the numeric **content id**. Resolve it from
`countries`:

```bash
reisewarnungen countries --compact \
  | jq -r '.[] | select(.countryName == "Thailand") | [.id,.countryName,.countryCode,.iso3CountryCode,.warning,.partialWarning] | @tsv'
```

Notes and traps:
- **Country names are German** (`Ägypten`, `Vereinigte Staaten`, `Russische Föderation`,
  `Côte d'Ivoire`). For an English request, match on `countryCode` (ISO-3166 alpha-2,
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
| *(all false)* | Routine travel & safety advice only, no warning | 🟢 **Advice only** |

> **Quirk.** In current live data only `warning` and `partialWarning` are ever set;
> `situation*` flags exist in the schema but are presently all `false` across every
> country. Don't claim a situation warning unless the flag is actually `true`.

A country counts as "warned" if **any** flag is true — that's exactly what
`countries --warned-only` filters on.

## Step 3 — Fetch the full advisory for the briefing

For the verdict you can stop at the flags, but for a real briefing fetch the HTML:

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
  Teilreisewarnung) — that's the load-bearing fact.
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
  false" as "no data"; it means advice-only, which is a valid, reassuring answer.
