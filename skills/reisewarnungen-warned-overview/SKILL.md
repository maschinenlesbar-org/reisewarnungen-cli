---
name: reisewarnungen-warned-overview
description: >
  Produce a ranked overview of every country currently under a German travel
  warning, using the reisewarnungen-cli (Auswärtiges Amt advice). Trigger when the
  user asks "which countries have a travel warning?", "where does Germany warn
  against travel?", "list all full travel warnings", "show warned countries in
  Africa", "how many countries are warned right now?", or wants the global / a
  regional picture. Aggregates and ranks the flat country list by severity and
  groups it the way the bare CLI doesn't.
version: 1.0.0
userInvocable: true
---

# Reisewarnungen Warned-Country Overview

Turn the flat country list into a **severity-ranked, grouped overview** of where the
Auswärtiges Amt currently warns against travel — full warnings first, then regional —
optionally filtered to a region the user named.

## Tooling

This skill drives the `reisewarnungen` command. **Before anything else, validate it is available** — run `command -v reisewarnungen` (or `reisewarnungen --version`). If it is not on your PATH, STOP and inform the user that the `reisewarnungen` CLI (`@maschinenlesbar.org/reisewarnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The CLI is read-only, **no API key**, over the open Auswärtiges Amt API. Always `--compact`. The whole job of this skill is the **ranking and grouping** the CLI deliberately doesn't do — it only filters (`--warned-only`), it doesn't rank.

## Step 1 — Pull the warned countries

One call gives everything you need; it already drops the unwarned majority:

```bash
reisewarnungen countries --warned-only --compact
```

Each entry: `id`, `countryName` (German), `countryCode` (alpha-2), `iso3CountryCode`
(alpha-3), `warning`, `partialWarning`, `situationWarning`, `situationPartWarning`,
`lastModified`, `effective`, `title`.

> **Scale.** ~200 countries total; typically **~45 warned** at any time (currently ~19
> full warnings, ~27 regional). That's a listable size — you can enumerate all of them,
> unlike some sibling APIs. Use plain `countries` (no flag) only if the user wants the
> *whole* world or a count of unwarned countries too.

## Step 2 — Classify and rank by severity

Assign each country its highest-severity flag and sort:

1. **🔴 Full warning** — `warning === true` (Reisewarnung, whole-country "do not travel").
2. **🟠 Regional warning** — `partialWarning === true` and not a full warning
   (Teilreisewarnung).
3. **🟡 Situation warning** — `situationWarning` / `situationPartWarning` true and neither
   of the above.

> **Quirk.** In current live data only `warning` and `partialWarning` are set; the
> `situation*` flags are all `false`. So in practice the ranking is just full → regional.
> Keep the situation tier in case the data starts using it, but don't fabricate it.

A country can have several flags; rank it by the **strongest** one, but you may note the
others (e.g. "full warning + regional notes").

## Step 3 — (Optional) filter by region

If the user named a region ("in Africa", "Middle East", "post-Soviet states"), filter by
country before ranking. There is **no region field** in the data — map from
`iso3CountryCode` / `countryCode` / the German `countryName` to the continent or region
yourself (e.g. ML, NE, BF, SD, SS, SO, CD → Africa). Say which countries you included if
the region is fuzzy, rather than silently guessing borders.

## Step 4 — Present the overview

Group by tier, full warnings first, with the German name, ISO code, and id:

```
German travel warnings — 46 countries warned (19 full, 27 regional)
Source: Auswärtiges Amt, as of 11 Jun 2026.

🔴 Full travel warning (Reisewarnung) — 19
  Afghanistan (AF · 204692)   Belarus (BY · 201904)   Haiti (HT · 205048)
  Iran (IR · 202396)          Irak (IQ · 202738)      Jemen (YE · 202260)
  Libanon (LB · 204048)       Libyen (LY · 219624)    Mali (ML · 208258)
  Myanmar (MM · 212100)       Niger (NE · 226384)     …

🟠 Regional warning (Teilreisewarnung) — 27
  Ägypten (EG · 212622)       Algerien (DZ · 219044)  Armenien (AM · 201872)
  Aserbaidschan (AZ · 201888) Benin (BJ · 208984)     Burkina Faso (BF · 212336)
  Côte d'Ivoire (CI · 209460) Indien (IN · 205998)    Israel (IL · 203814)   …
```

Rules:
- **Lead with totals per tier** — the count is the headline number.
- List 🔴 **full warnings in full** (it's the high-stakes set). For 🟠 regional, list all
  if the user wants the complete picture, or the count + a representative sample if they
  asked something narrower.
- Show the **German country name** (it's authoritative), the ISO alpha-2 code (for
  international readers), and the **content id** so the user can drill in with
  `reisewarnungen get <id>` — wire that follow-up: "want the details on any of these?".
- For a regional warning, remember it applies to **parts** of the country, not all of it —
  don't imply the whole country is off-limits.
- If `--warned-only` returns `[]` (exit `0`), that means **no warnings are in force right
  now** — report that as the (good) news, and optionally double-check with plain
  `countries` that the API is returning data at all.
- Offer the natural drill-down (`reisewarnungen-trip-check` for a specific country) and,
  for tracking changes over time, the `reisewarnungen-watch` workflow.
