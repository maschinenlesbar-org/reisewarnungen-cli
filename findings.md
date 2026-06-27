# reisewarnungen-cli — Exploratory testing findings (all resolved)

**Session:** 2026-06-27. Exploratory testing pass, then all 8 findings fixed.
**Build:** `@maschinenlesbar.org/reisewarnungen-cli@0.0.2`, Node v22.14.0, from source.
**Status:** ✅ 45 tests pass (37 original + 8 added); `typecheck` clean.

The CLI was already solid (validation, exit codes, the `-o` happy path, path-traversal
encoding, protocol guard). The eight items below were found and fixed.

---

## Fixed

### 1. Any global flag with no command → help on stderr + exit 1 (vs stdout + exit 0 for bare/`--help`)
The guard in [run.ts](src/cli/run.ts) only handled `argv.length === 0`, so
`reisewarnungen --compact` / `-o x.json` fell through to commander (stderr + exit 1).
Replaced with commander `parseOptions`-based detection: empty `operands` *and* empty
`unknown` → print help to stdout, exit 0; `--help`/`--version`/unknown commands/options
still fall through to commander unchanged.

### 2. `-o/--output` write failures reported as `Unexpected error: <errno>`
A bad path (directory, missing parent, permission) hit run()'s catch-all with a raw
Node errno. [shared.ts](src/cli/shared.ts) now wraps the write and throws a clean
`ReiseError` → `Error: Could not write to <path>: <reason>`, exit 1.

### 3. `--base-url <malformed>` echoed the full request path
`Invalid URL: notaurl/opendata/travelwarning` read as if the path were at fault.
[engine.ts](src/client/engine.ts) `buildUrl` now validates the base up front:
`Error: Invalid base URL: "notaurl"`. (Same fix as smard-cli.)

### 4. `get` accepted trailing garbage after a valid id and silently returned that country
`get 199124x` → Polen (exit 0) while `get abc` → 404, due to upstream leniency + the
`soleEntry` fallback. [warnings.ts](src/cli/commands/warnings.ts) now validates the
content id is numeric (`/^\d+$/`) up front, so every malformed id is a consistent usage
error (exit 1). The client's `soleEntry` tolerance is unchanged (still covers the
documented key-differs case).

### 5. `-o ""` silently wrote to stdout and created no file
An empty `--output` was falsy and fell back to stdout. Added a `parseOutputPath`
value-parser ([shared.ts](src/cli/shared.ts)) wired into the `-o` option, so `-o ""` is
rejected as an invalid argument.

### 6. Repo follows redirects, contradicting the workspace "redirects are NOT followed" constraint
Kept the (good, tested, credential-stripping) redirect behavior and fixed the
contradiction at its source: [`../CLAUDE.md`](../CLAUDE.md) now states redirect handling
is **per-repo** (most don't follow; some, like this one, follow up to `maxRedirects`
with cross-origin header stripping).

### 7. `--max-redirects` was an engine option but not a CLI flag
Added `--max-redirects <n>` (program.ts), plumbed through `GlobalOptions` →
`toEngineOptions` ([shared.ts](src/cli/shared.ts)); documented in README/Usage.

### 8. Dead raw-download path (CLI **and** library)
The CLI has no raw command, so `renderRaw` (shared.ts) and `outBinary` (CliIO/defaultIO/
test mock) were unused — removed. Also trimmed the unused **library** surface:
`RequestEngine.getRaw` is gone, bringing the engine back in line with the reference
impl (smard-cli), which has public `request()`/`getJson()` but no `getRaw`. `RawResponse`
is retained — it is `request()`'s return type (exported in the reference too), not raw
dead code. Updated DEVELOPING.md (CliIO note, "JSON/raw" → "JSON", RawResponse wording).

---

## Tests added (8)
- no-command and global-flag-no-command → help on stdout, exit 0
- unknown command still errors (exit 1)
- `get` rejects a non-numeric id before any request
- `--output` writes the file + stderr confirmation, stdout stays clean
- a failed `--output` write → clean `Error:` (not `Unexpected error`), exit 1
- `--max-redirects` parses and reaches the client
- engine: malformed base URL → clear, base-only message
