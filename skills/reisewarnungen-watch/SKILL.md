---
name: reisewarnungen-watch
description: >
  Track changes in German travel warnings over time using the reisewarnungen-cli
  (Auswärtiges Amt advice). Trigger when the user asks "what travel warnings
  changed since last week?", "diff today's warnings against this snapshot",
  "which countries had their advice updated recently?", "alert me to new travel
  warnings", "did the warning for X change?", or wants monitoring / a snapshot
  diff rather than a one-off lookup. Saves a dated snapshot and compares two to
  surface newly-warned, lifted, and freshly-updated countries.
version: 1.0.0
userInvocable: true
---

# Reisewarnungen Watch / Diff

Detect **what changed** in the Auswärtiges Amt advice between two points in time — which
countries gained or lost a warning, and which had their advisory updated — instead of
re-reading the whole list and eyeballing it.

## Tooling

This skill drives the `reisewarnungen` command. **Before anything else, validate it is available** — run `command -v reisewarnungen` (or `reisewarnungen --version`). If it is not on your PATH, STOP and inform the user that the `reisewarnungen` CLI (`@maschinenlesbar.org/reisewarnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The CLI is read-only, **no API key**. Always `--compact`. The CLI has **no diff or watch mode** — that's this skill's whole job: take dated snapshots and compare them.

## Step 1 — Take a snapshot

`countries --compact` is the right snapshot shape: a flat array carrying each country's
flags and its `lastModified` timestamp. Save it dated, with `-o`:

```bash
reisewarnungen countries --compact -o reisewarnungen-2026-06-11.json
```

> Use **`countries`**, not `list`, for snapshots: `countries` is a clean array with `id`
> per entry; `list` is a map and its top-level `lastModified` (≈ Nov 2024 in current data)
> is a stale dataset-level value that does **not** track per-country edits — use the
> **per-country** `lastModified` instead.

For a freshness-only view (no prior snapshot) you can skip straight to Step 3.

## Step 2 — Diff two snapshots

Given an old and a new snapshot, key both by `id` and compare. Three change classes:

- **Newly warned** — a country whose warned-status flipped to true (any of `warning`,
  `partialWarning`, `situationWarning`, `situationPartWarning` went `false → true`), or a
  country that escalated `partialWarning → warning`.
- **Warning lifted / downgraded** — warned-status flipped to false, or `warning →
  partialWarning`.
- **Advisory updated** — flags unchanged but `lastModified` increased (the text was
  revised).

```bash
# new vs old, both produced by Step 1
jq -n --slurpfile old reisewarnungen-2026-06-04.json --slurpfile new reisewarnungen-2026-06-11.json '
  ($old[0] | map({key:.id, value:.}) | from_entries) as $o
  | ($new[0] | map({key:.id, value:.}) | from_entries) as $n
  | def warned(c): (c.warning or c.partialWarning or c.situationWarning or c.situationPartWarning);
  { newlyWarned: [ $n[] | select(warned(.) and (($o[.id]|.==null) or (warned($o[.id])|not))) | {id,countryName,countryCode} ],
    lifted:      [ $o[] | select(warned(.) and (($n[.id]|.==null) or (warned($n[.id])|not))) | {id,countryName,countryCode} ],
    updated:     [ $n[] | select($o[.id] != null and .lastModified > $o[.id].lastModified) | {id,countryName,lastModified} ] }'
```

> **Traps.**
> - Compare by **`id`**, not by name — names are stable but ids are the real key, and a
>   country can appear/disappear from the catalogue.
> - `lastModified` is Unix **seconds** (not ms, despite older docs). Convert with
>   `× 1000` for `Date`; a bare value like `1780665504` is June 2026.
> - A pure `lastModified` bump means the advisory text changed but the warning *level* may
>   not have — class it as "updated", not "new warning".

## Step 3 — Freshness view (single snapshot, no diff)

If the user just wants "what was updated recently", sort the current `countries` by
`lastModified` descending and show the most recent edits:

```bash
reisewarnungen countries --compact \
  | jq -r 'sort_by(-.lastModified) | .[:15][]
      | [(.lastModified|todate), .countryCode, .countryName,
         (if .warning then "WARN" elif .partialWarning then "PART" else "advice" end)] | @tsv'
```

`(.lastModified|todate)` works because the value is already seconds. To answer "did X
change since DATE?", filter `select(.lastModified > (DATE|fromdate))`.

## Step 4 — Report the changes

```
Travel-warning changes, 4 Jun → 11 Jun 2026

🆕 Newly warned (2)
   🟠 Peru (PE · 224…)        regional warning added
   🔴 Mali (ML · 208258)      escalated: regional → full

✅ Lifted / downgraded (1)
   Tunesien (TN · …)          warning lifted → advice only

✏️  Advisory updated, same level (6)
   Thailand, Israel, Kenia, Guatemala, Botsuana, Palästinensische Gebiete*
```

Rules:
- **Lead with the escalations** (🆕 newly warned, and partial→full upgrades) — those are
  what someone monitoring this cares about most.
- Separate **level changes** (new / lifted / up- / downgraded) from **text-only updates**
  (`lastModified` bumped, same flags). Don't let a routine editorial edit read as a new
  warning.
- Give the German name + ISO code + content id so the user can drill in
  (`reisewarnungen get <id>`, or hand off to `reisewarnungen-trip-check`).
- For a recurring watch, suggest saving today's `countries --compact` snapshot (Step 1)
  and re-running the diff next time; the CLI does the fetch, this skill does the compare.
- If there are no snapshots to diff yet, do the Step 3 freshness view and offer to start a
  snapshot baseline now.
