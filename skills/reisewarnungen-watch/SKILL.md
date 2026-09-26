---
name: reisewarnungen-watch
description: >
  Track changes in German travel warnings over time using the reisewarnungen-cli
  (Auswärtiges Amt advice). Trigger when the user asks "what travel warnings
  changed since last week?", "diff today's warnings against this snapshot",
  "which countries had their advice updated recently?", "alert me to new travel
  warnings", "did the warning for X change?", or wants monitoring / a snapshot
  diff rather than a one-off lookup. Saves a dated snapshot and compares two to
  surface newly-warned, escalated, downgraded, lifted and freshly-updated
  countries.
compatibility: >
  Requires the `reisewarnungen` CLI (npm package
  @maschinenlesbar.org/reisewarnungen-cli) on PATH, installed by the user; the
  skill never installs it. Uses jq for JSON filtering. Network access to
  www.auswaertiges-amt.de.
---

# Reisewarnungen Watch / Diff

Detect **what changed** in the Auswärtiges Amt advice between two points in time — which
countries gained or lost a warning, and which had their advisory updated — instead of
re-reading the whole list and eyeballing it.

## Tooling

This skill drives the `reisewarnungen` command. **Before anything else, validate it is available** — run `command -v reisewarnungen` (or `reisewarnungen --version`). If it is not on your PATH, STOP and inform the user that the `reisewarnungen` CLI (`@maschinenlesbar.org/reisewarnungen-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

The CLI is read-only, **no API key**. Always `--compact`. The CLI has **no diff or watch mode** — that's this skill's whole job: take dated snapshots and compare them.

## Step 1 — Take a snapshot

`countries --compact` is the right snapshot shape: a flat array carrying each country's
flags and its `lastModified` timestamp. Save it dated, with `-o`:

```bash
reisewarnungen countries --compact -o reisewarnungen-2026-06-11.json
```

> **Trap — `-o` never overwrites.** If the file exists (a second snapshot the same day),
> the CLI exits `1` with `Refusing to overwrite existing file …; pass --force to
> overwrite.` Ask the user before replacing an existing snapshot, since it may be the
> baseline for a diff. Then either add `--force` or pick a new name (e.g. add the time:
> `reisewarnungen-2026-06-11T1430.json`). On success the CLI prints `Wrote N bytes to …`
> on stderr; tell the user the file name.

> Use **`countries`**, not `list`, for snapshots: `countries` is a clean array with `id`
> per entry; `list` is a map and its top-level `lastModified` is a stale dataset-level
> value that does **not** track per-country edits (on 2026-09-15 it was `1757063288`,
> 2025-09-05, while country entries had been edited that day) — use the **per-country**
> `lastModified` instead.

For a freshness-only view (no prior snapshot) you can skip straight to Step 3.

## Step 2 — Diff two snapshots

Given an old and a new snapshot, key both by `id` and compare. Each country has a
warning **level**: `full` (`warning`), `partial` (`partialWarning`, or one of the
situational flags `situationWarning` / `situationPartWarning`), or `none`. The change
classes:

- **Newly warned** — level went from `none` (or the country was absent) to `partial`/`full`.
- **Escalated** — both warned, level went up: `partial → full`.
- **Downgraded** — both warned, level went down: `full → partial`.
- **Lifted** — level went from `partial`/`full` to `none`, or the country left the
  catalogue (`gone: true`).
- **Flags changed, same level** — e.g. `partialWarning → situationPartWarning`; report it,
  it is not a text-only edit.
- **Advisory updated** — all four flags unchanged but `lastModified` increased (the text
  was revised).

```bash
# new vs old, both produced by Step 1
jq -n --slurpfile old reisewarnungen-2026-06-04.json --slurpfile new reisewarnungen-2026-06-11.json '
  ($old[0] | map({key:.id, value:.}) | from_entries) as $o
  | ($new[0] | map({key:.id, value:.}) | from_entries) as $n
  | def level(c): if c == null then 0 elif c.warning == true then 2
        elif (c.partialWarning or c.situationWarning or c.situationPartWarning) == true then 1 else 0 end;
    def lname(l): ["none", "partial", "full"][l];
    def flags(c): [c.warning, c.partialWarning, c.situationWarning, c.situationPartWarning] | map(. == true);
  { newlyWarned:  [ $n[] | select(level(.) > 0 and level($o[.id]) == 0) | {id,countryName,countryCode,level:lname(level(.))} ],
    escalated:    [ $n[] | select(level($o[.id]) > 0 and level(.) > level($o[.id])) | {id,countryName,countryCode,from:lname(level($o[.id])),to:lname(level(.))} ],
    downgraded:   [ $n[] | select(level(.) > 0 and level($o[.id]) > level(.)) | {id,countryName,countryCode,from:lname(level($o[.id])),to:lname(level(.))} ],
    lifted:       [ $o[] | select(level(.) > 0 and level($n[.id]) == 0) | {id,countryName,countryCode,from:lname(level(.)),gone:($n[.id] == null)} ],
    flagsChanged: [ $n[] | select($o[.id] != null and level(.) == level($o[.id]) and flags(.) != flags($o[.id])) | {id,countryName,countryCode} ],
    updated:      [ $n[] | select($o[.id] != null and flags(.) == flags($o[.id]) and .lastModified > $o[.id].lastModified) | {id,countryName,lastModified} ] }'
```

> **Traps.**
> - Compare by **`id`**, not by name — names are stable but ids are the real key, and a
>   country can appear/disappear from the catalogue.
> - `lastModified` is Unix **seconds** (not ms, despite older docs). Convert with
>   `× 1000` for `Date`; a bare value like `1780665504` is June 2026.
> - A pure `lastModified` bump means the advisory text changed but the warning *level* may
>   not have — class it as "updated", not "new warning".
> - Don't test only "warned or not" (any flag true): a `partial → full` escalation or a
>   `full → partial` downgrade keeps that the same, and usually comes with a
>   `lastModified` bump, so it would read as a same-level text update. Compare the
>   **level** (and the four flags for "updated"), as the program above does.

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

🆕 Newly warned (1)
   🟠 Peru (PE · 224…)        regional warning added

⬆️  Escalated (1)
   🔴 Mali (ML · 208258)      regional → full

⬇️  Downgraded (1)
   🟠 Tunesien (TN · …)       full → regional

✅ Lifted (1)
   Kenia (KE · …)             regional warning lifted → advice only

✏️  Advisory updated, same level (6)
   Thailand, Israel, Kenia, Guatemala, Botsuana, Palästinensische Gebiete*
```

Rules:
- **Lead with the escalations** (🆕 `newlyWarned`, then `escalated` partial → full) — those
  are what someone monitoring this cares about most.
- Separate **level changes** (`newlyWarned` / `escalated` / `downgraded` / `lifted`, plus
  `flagsChanged`) from **text-only updates** (`updated`: `lastModified` bumped, same
  flags). Don't let a routine editorial edit read as a new warning, and don't let a level
  change read as a routine edit.
- Give the German name + ISO code + content id so the user can drill in
  (`reisewarnungen get <id>`, or hand off to `reisewarnungen-trip-check`).
- For a recurring watch, suggest saving today's `countries --compact` snapshot (Step 1)
  and re-running the diff next time; the CLI does the fetch, this skill does the compare.
- If there are no snapshots to diff yet, do the Step 3 freshness view and offer to start a
  snapshot baseline now.
