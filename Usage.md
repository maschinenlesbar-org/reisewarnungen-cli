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

The four subcommands are: `list`, `countries`, `get`, and `advice`.

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

### 4a. Check whether the advisory advises against travel, flags or not

Why: the flags record only the formal warning levels. „Von Reisen … wird
abgeraten", „Vermeiden Sie … Reisen", „Meiden Sie möglichst Reisen …" or „… sollte
gemieden werden" live in the text alone — a country with all four flags `false`
can still advise against travel to a region (Türkei, Angola, Bangladesch, Jordanien
…).

```bash
reisewarnungen advice 201962 --compact | jq -r '.sentences[] | select(.travel) | "[\(.section)] \(.text)"'
```

`advice` prints the flags plus every sentence that warns or advises against
something, whole (not cut at „z. B."), with its `section` and `travel: true` when
it mentions travel, a stay or a part of the country. Read the `travel` sentences:
some advise against travel to a region, others are about night driving or crowds.

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

`-o/--output` writes the command output to the given path instead of stdout. It
refuses to overwrite an existing file (exit 1); pass `--force` to overwrite.

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

A loopback host like `localhost` runs without a warning. A remote mirror on plain
`http:` works too, but the CLI says on stderr that its requests travel unencrypted:

```text
$ reisewarnungen --base-url http://mirror.example countries
2026-10-09T14:03:12.481Z WARN  [reisewarnungen.http] requests to mirror.example are sent unencrypted (http:, not https:)
```

Global options may be given before or after the command, so
`reisewarnungen countries --compact` and `reisewarnungen --compact countries`
are equivalent.

## Global options

Real flags only, from `reisewarnungen --help`:

| Option | Description |
| --- | --- |
| `-V, --version` | Output the version number |
| `--base-url <url>` | API base URL (default `https://www.auswaertiges-amt.de`; `http`/`https`, a path prefix is fine, no `?query` or `#fragment`, no surrounding whitespace). A `user:password@` in it is sent as HTTP Basic auth and never printed (`***`); write a literal `%` in it as `%25`. A plain `http:` base URL to a remote host logs one `WARN` record of `reisewarnungen.http` on stderr (`… sent unencrypted to <host> (http:, not https:)`) before the first request (naming the base URL's credentials when it carries any, never printing them); loopback hosts (`localhost`, `127.x`, `::1`) don't warn, and stdout and the exit code are unchanged |
| `--timeout <ms>` | Time limit per request in milliseconds, whole response included (default `30000`; at most `2147483647`; `0` = no limit, the request may wait forever) |
| `--user-agent <ua>` | `User-Agent` header value (non-blank, Latin-1, no control characters) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`–`10`; each waits a backoff — 200 ms, 400 ms, … for a `503`, from 1 s doubling for a `429` — or longer if the server's `Retry-After` asks, up to 30 s; a longer `Retry-After` is not retried; each retry logs one WARN record of `reisewarnungen.http` before it waits, `HTTP 503 from host: retry 1 of 3 in 2 s`) |
| `--max-redirects <n>` | HTTP redirects to follow (`0` = none; default `5`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [reisewarnungen.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `-o, --output <file>` | Write output to this file instead of stdout; `-o -` means stdout (no file named `-`) |
| `--force` | Overwrite the `--output` file if it already exists |
| `-h, --help` | Display help for a command |

Note: `-o/--output` is **trusted input** — the path is written verbatim with no
traversal guard (you own your shell). An existing file is **not** overwritten
unless you pass `--force`; a directory is refused with `"<path>" is a directory;
give a file path to --output.` (exit 1).

Exit codes: `0` success, `4` when `get` finds no such country, `1` for any other
error (a `404` on `list`/`countries` is `1`: the endpoint itself is missing); usage errors use commander's own non-zero code, while `--help` /
`--version` exit `0`.
