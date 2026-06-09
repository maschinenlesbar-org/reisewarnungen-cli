# reisewarnungen-cli

[![CI](https://github.com/maschinenlesbar-org/reisewarnungen-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/reisewarnungen-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/reisewarnungen-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/reisewarnungen-cli/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/maschinenlesbar-org/reisewarnungen-cli)](https://github.com/maschinenlesbar-org/reisewarnungen-cli/releases/latest)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/reisewarnungen-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/reisewarnungen-cli)

Check Germany's official **travel and safety warnings** by country from your
terminal. `reisewarnungen` is a small command-line tool over the
[Auswärtiges Amt travel-warning open-data API](https://www.auswaertiges-amt.de/opendata/travelwarning)
— list all countries, filter to those with active warnings, and fetch the full
advisory text — as clean JSON you can pipe straight into
[`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install and run.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Three focused commands** — `list`, `countries`, and `get`.
- **Save to file** — write output directly to a file with `-o/--output` instead of stdout.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/reisewarnungen-cli
```

This installs the **`reisewarnungen`** command. Requires **Node.js 20+**.

Check it works:

```bash
reisewarnungen --help
```

## Quickstart

No setup needed — the API is open data, no key required. Your first query:

```bash
reisewarnungen countries
```

Each entry in the result array has an `id`, `countryName`, and the four warning
flags. Filter to only countries with an active warning:

```bash
reisewarnungen countries --warned-only
```

Pull out just country names and ids with `jq`:

```bash
reisewarnungen countries --warned-only | jq '.[] | {id, countryName}'
```

Fetch the full advisory text (HTML `content` included) for one country:

```bash
reisewarnungen get 226768
```

## Commands

```text
list                        all warnings, keyed by content id (raw response)
countries [--warned-only]   flattened overview (id, country, warning flags)
get <contentId>             one country's full warning (with HTML content)
```

The `<contentId>` is the numeric key from `list` / the `id` field from `countries`.

### `countries` options

| Flag | Meaning |
| --- | --- |
| `--warned-only` | only countries with a warning of any kind in force |

A country is included by `--warned-only` if **any** of `warning`,
`partialWarning`, `situationWarning`, or `situationPartWarning` is true.
The **[Glossary](GLOSSARY.md)** explains every warning flag.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# All countries with any kind of warning in force
reisewarnungen countries --warned-only

# Find a country's content id by name, then fetch the full advisory
reisewarnungen countries --compact | jq -r '.[] | select(.countryName == "Ukraine") | .id'
reisewarnungen get 201946

# Quick table of warned countries (code, id, name)
reisewarnungen countries --warned-only --compact \
  | jq -r '.[] | [.countryCode, .id, .countryName] | @tsv'

# Filter by ISO-3 country code
reisewarnungen countries --compact \
  | jq '.[] | select(.iso3CountryCode == "UKR")'

# Save the full raw dataset to a file
reisewarnungen list -o warnings-2026-06-08.json
```

## Output & scripting

Every command prints **pretty JSON to stdout** (or to a file with `-o`). Errors
and diagnostics go to stderr, so piping stdout into `jq` stays clean.

```bash
# Extract the HTML advisory text from a single warning
reisewarnungen get 226768 --compact | jq -r '.content'

# Count how many countries are currently warned
reisewarnungen countries --warned-only | jq 'length'

# Raw response with all envelope members (lastModified, contentList)
reisewarnungen list | jq '.lastModified'
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
reisewarnungen --compact countries --warned-only | jq -c '.[]'
```

`--compact` (and every global option) works **before or after** the command —
both `reisewarnungen --compact countries` and `reisewarnungen countries --compact`
do the same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `4` | country not found — upstream `404` or a `get` whose response holds no matching entry |
| `1` | any other error — including bad usage / invalid arguments |

## Troubleshooting

- **`command not found: reisewarnungen`** — the global npm bin directory isn't on
  your `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/reisewarnungen-cli …`.
- **Exit `4` / "not found"** — the content id doesn't exist or the advisory has
  been removed. Re-fetch it from a fresh `countries` result; ids can change as
  the catalogue updates.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again, or
  raise the limit with `--timeout 60000`.
- **Empty array from `countries --warned-only`** — no warnings are currently in
  force, or the upstream data was recently reset; try `countries` without the
  flag to verify the API is returning data.
- **HTML in `content`** — the advisory text is delivered as HTML by the upstream
  API. Use `jq -r '.content'` to print it raw, or pipe it through an HTML
  renderer.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `-o, --output <file>` | Write output to this file instead of stdout |
| `--base-url <url>` | API base URL (default `https://www.auswaertiges-amt.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

The `-o/--output` path is **trusted input** — it is written verbatim with no
traversal or overwrite guard (you own your shell).

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every domain term and warning flag explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
