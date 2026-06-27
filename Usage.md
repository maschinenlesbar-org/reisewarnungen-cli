# Usage

Use-case-driven examples for `reisewarnungen`, a command-line client for the open
[Auswärtiges Amt travel-warning API](https://www.auswaertiges-amt.de/opendata/travelwarning)
— official German travel and safety advisories by country. It reads the open
data (no auth) and prints unwrapped JSON you can pipe straight into `jq`.

## Install

```bash
npm i -g @maschinenlesbar.org/reisewarnungen-cli
```

This installs the `reisewarnungen` bin. Without a global install you can run the
built CLI directly with `node dist/src/cli/index.js`.

All three subcommands are: `list`, `countries`, and `get`.

## Use cases

### 1. List every travel warning (raw response)

Why: get the full upstream `response` envelope, keyed by content id, for archiving
or downstream processing.

```bash
reisewarnungen list
```

The output is the raw, pretty-printed response map (numeric content-id keys plus
the `lastModified` and `contentList` envelope members). Add `--compact` for a
single-line payload suited to logs or further piping.

### 2. Get a flattened overview of all countries

Why: the raw list mixes envelope scalars in with country entries; `countries`
flattens it into a clean array where each item carries its own `id`.

```bash
reisewarnungen countries
```

Each entry has `id`, `countryName`, `countryCode`, `iso3CountryCode`, and the
warning flags (`warning`, `partialWarning`, `situationWarning`,
`situationPartWarning`).

### 3. Show only countries with an active warning

Why: skip the noise and see just the countries where a warning of any kind is in
force.

```bash
reisewarnungen countries --warned-only
```

`--warned-only` keeps an entry if any of `warning`, `partialWarning`,
`situationWarning`, or `situationPartWarning` is true.

### 4. Read the full warning text for one country

Why: the full HTML advisory text (`content`) is only returned by the
single-warning endpoint, so use `get` with the country's content id.

```bash
reisewarnungen get 226768
```

The `<contentId>` is the numeric key from `list` / the `id` field from
`countries`. The returned entry includes the HTML `content`, `title`, and
`effective`/`lastChanges` metadata.

### 5. Find a country's content id by name, then fetch it

Why: you usually know the country, not its numeric id. Resolve the id from
`countries`, then pass it to `get`.

```bash
# Look up the id for, e.g., Ukraine
reisewarnungen countries --compact | jq -r '.[] | select(.countryName == "Ukraine") | .id'

# Then fetch that warning (substitute the id printed above)
reisewarnungen get 201946
```

### 6. List active warnings as a tidy country/id table

Why: a quick human-readable shortlist of where warnings apply, without the HTML.

```bash
reisewarnungen countries --warned-only --compact \
  | jq -r '.[] | [.countryCode, .id, .countryName] | @tsv'
```

`--compact` keeps the JSON on one line so `jq` consumes it cleanly; `@tsv`
produces tab-separated columns.

### 7. Look up by ISO country code

Why: filter by a stable code (`countryCode` like `UA`, or `iso3CountryCode` like
`UKR`) instead of a display name.

```bash
reisewarnungen countries --compact \
  | jq '.[] | select(.iso3CountryCode == "UKR")'
```

### 8. Save output to a file

Why: snapshot the data for reporting, diffing over time, or sharing.

```bash
# Full raw list to a file
reisewarnungen list -o warnings-2026-06-08.json

# Just the active warnings, compact
reisewarnungen countries --warned-only --compact -o active.json
```

`-o/--output` writes the command output to the given path instead of stdout.

### 9. Extract just the warning text from a single advisory

Why: pull the human-readable advisory out of the JSON for a report or email.

```bash
reisewarnungen get 226768 --compact | jq -r '.content'
```

### 10. Point at a mock or staging endpoint with a custom timeout

Why: test against a local fixture server, or tighten the per-request timeout in
a flaky network.

```bash
reisewarnungen --base-url http://localhost:8080 --timeout 5000 countries
```

Global options may be given before or after the command, so
`reisewarnungen countries --compact` and `reisewarnungen --compact countries`
are equivalent.

## Global options

Real flags only, from `reisewarnungen --help`:

| Option | Description |
| --- | --- |
| `-V, --version` | Output the version number |
| `--base-url <url>` | API base URL (default `https://www.auswaertiges-amt.de`) |
| `--timeout <ms>` | Per-request timeout in milliseconds |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses |
| `--max-redirects <n>` | HTTP redirects to follow (`0` = none; default `5`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `-h, --help` | Display help for a command |

Note: `-o/--output` is **trusted input** — the path is written verbatim with no
traversal or overwrite guard (you own your shell).

Exit codes: `0` success, `4` when a country is not found, `1` for any other
error; usage errors use commander's own non-zero code, while `--help` /
`--version` exit `0`.
