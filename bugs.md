# Exploratory bug report — reisewarnungen-cli

## Environment / method

- Built with `npm run build` (clean, no errors). Invoked as
  `node dist/src/cli/index.js ...` from the package root.
- Node platform: darwin (macOS), zsh.
- The Auswärtiges Amt API was **reachable** during testing:
  `curl https://www.auswaertiges-amt.de/opendata/travelwarning` → HTTP 200,
  ~76 KB JSON. Live `list` / `countries` / `get 226768` all returned real data,
  and `get 226768` did contain the HTML `content` field (37 KB).
- Edge cases for upstream-shape handling were reproduced with a tiny local
  `http.createServer` mock pointed at via `--base-url`.

**Total genuine, reproducible bugs found: 8** (1 high, 3 medium, 4 low).
Many "probe" candidates from the brief turned out to be correctly handled (see
"Verified correct" at the end) — I am only listing real defects.

---

## High severity

### 1. Numeric global flags silently accept hex / exponent / whitespace / empty via bare `Number()`
- **Severity:** High · **Confidence:** High
- **Repro (hex parsed as a real value):**
  ```
  node dist/src/cli/index.js --timeout 0x10 list
  ```
  **Expected:** `0x10` rejected as not a valid integer (same as `--timeout abc`,
  which *is* rejected with exit 1 and a usage error).
  **Actual:** Accepted. `0x10` is silently coerced to `16`, so the request is
  given a 16 ms timeout and dies:
  ```
  Error: Request timed out after 16ms
  exit=1
  ```
- **Repro (empty string disables the timeout entirely):**
  ```
  node dist/src/cli/index.js --timeout "" countries --warned-only   # exit 0, succeeds
  node dist/src/cli/index.js --timeout 1  countries --warned-only   # Error: Request timed out after 1ms, exit 1
  ```
  **Expected:** `--timeout ""` rejected as invalid.
  **Actual:** `Number("")` is `0`; `0` means "timeout disabled", so an empty value
  silently turns off the request timeout instead of erroring.
- **Other inputs that are wrongly accepted** (verified directly against the
  validator):
  | input | `Number()` result accepted as |
  | --- | --- |
  | `"0x10"` | 16 |
  | `"0b101"` | 5 |
  | `"1e3"` | 1000 |
  | `"+7"` | 7 |
  | `""` | 0 |
  | `"   "` (whitespace only) | 0 |
  | `"  42  "` (padded) | 42 |
  | `"99999999999999999999"` | 1e20 (precision lost; not the integer typed) |

  These apply to **every** numeric flag: `--timeout`, `--max-retries`,
  `--max-response-bytes`. e.g. `--max-retries 1e3` would be accepted as 1000
  retries.
- **Root cause:** `src/cli/shared.ts:11-17` `parseIntArg` uses
  `const n = Number(value)` and only rejects on `!Number.isInteger(n) || n < 0`.
  `Number()` happily parses hex/binary/exponent/`+`-prefixed/whitespace/empty
  strings to integers, so they pass the `Number.isInteger` gate. A radix-10
  parse with a strict `^\d+$` / `Number.parseInt` + format check is needed.

---

## Medium severity

### 2. A 200 response missing the `response` envelope is masked as empty success (`{}` / `[]`), exit 0
- **Severity:** Medium · **Confidence:** High
- **Repro** (local mock that returns `{"foo":"bar"}` for the list endpoint):
  ```
  # mock server returns 200 {"foo":"bar"} for /opendata/travelwarning
  node dist/src/cli/index.js --base-url http://127.0.0.1:$PORT list
  node dist/src/cli/index.js --base-url http://127.0.0.1:$PORT countries
  ```
  **Expected:** An upstream 200 whose body lacks the documented `response`
  envelope is a broken/unexpected response and should surface as an error (parse
  / shape error → exit 1), consistent with how `get` surfaces "no matching
  entry" as exit 4 rather than printing nothing.
  **Actual:**
  ```
  list      -> {}    exit=0
  countries -> []    exit=0
  countries --warned-only -> []  exit=0
  ```
  A malformed or wrong-API endpoint is reported as a clean empty success,
  silently hiding data loss from any script that consumes the output.
- **Root cause:** `src/client/client.ts:29` (`return res.response ?? {}`) and the
  `summaries()`/filter chain. The `?? {}` fallback swallows a missing envelope
  instead of raising a `ReiseParseError`.

### 3. `-o/--output` is advertised in `--help` but silently does nothing for every command
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```
  rm -f /tmp/out.json
  node dist/src/cli/index.js -o /tmp/out.json list
  ls /tmp/out.json    # No such file or directory
  ```
  **Expected:** Either the flag writes output to the file, or (since no command
  emits raw bytes yet) using it is rejected/warned.
  **Actual:** Exit 0, JSON is written to **stdout** as usual, and the named file
  is **never created**. A user redirecting output to a file via `-o` silently
  loses it. The `--help` text ("write bytes to this file instead of stdout")
  actively misleads; only the README footnote admits it is reserved.
- **Root cause:** `renderJson` (`src/cli/shared.ts:57-60`) ignores `global.output`
  entirely; `renderRaw` (which honors `--output`) is never wired to any command
  (`src/cli/commands/warnings.ts` only ever calls `renderJson`).

### 4. Empty `get` id round-trips to the network instead of being a usage error
- **Severity:** Medium · **Confidence:** Medium
- **Repro:**
  ```
  node dist/src/cli/index.js get ""
  ```
  **Expected:** An empty content id is a usage/argument error (exit 1, "missing
  required argument" semantics), not a real HTTP request.
  **Actual:** It issues `GET .../opendata/travelwarning/` (trailing slash, empty
  segment) and reports:
  ```
  Error: HTTP 404 for GET https://www.auswaertiges-amt.de/opendata/travelwarning/
  exit=4
  ```
  An empty id is structurally invalid yet causes a network call and an exit-4
  "not found" rather than an input-validation failure.
- **Root cause:** `src/cli/commands/warnings.ts:35-37` passes the positional
  straight to `client.get(id!)` with no non-empty check; `client.get`
  (`src/client/client.ts:59-60`) builds the URL from `encodeURIComponent("")`.

---

## Low severity

### 5. `list` exposes an undocumented `contentList` envelope key
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js list | node -e 'const d=require("fs").readFileSync(0,"utf8");console.log("contentList" in JSON.parse(d))'
  # -> true
  ```
  **Expected:** Per the README/types, the list envelope is "a `lastModified`
  scalar plus one numeric-string key per country". `list` returns **202** keys =
  201 country-ish keys + `lastModified`, but one of those 201 keys is
  `contentList` (an array of all ids), so there are 200 real countries.
  **Actual:** `list` faithfully passes `contentList` through (so `list` is not
  wrong), but the documented shape is incomplete and downstream code that
  iterates "all non-`lastModified` keys" as countries would treat `contentList`
  as a country. `summaries()` happens to drop it only because it is an array
  (`!Array.isArray(value)` guard at `client.ts:41`), which is incidental, not a
  deliberate skip like the `lastModified` special-case.
- **Root cause:** `src/client/client.ts:39-44` and `types.ts` only special-case
  `lastModified`; `contentList` is an unmodeled, undocumented envelope member.

### 6. `--help` text for `-o/--output` claims a behavior the tool does not implement
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --help    # shows: "-o, --output <file>  for downloads: write bytes to this file instead of stdout"
  ```
  **Expected:** Help should not promise an effect that no command produces (the
  README qualifies it as "reserved for future ... no current command emits raw
  output"; the in-CLI help does not).
  **Actual:** The help string reads as a working option. (Companion to bug #3.)
- **Root cause:** `src/cli/program.ts:40`.

### 7. Bare invocation (no command) prints help to stdout but exits 1
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js ; echo $?
  ```
  **Expected:** Running with no args to get an overview is a benign,
  commonly-intentional action; many CLIs exit 0 (as `--help` does, exit 0).
  **Actual:** The full help is printed and exit code is **1**, so a wrapper
  script "just run it to see what it does" registers a failure. Inconsistent
  with `--help` (exit 0). (Minor/arguably-intentional commander default, but a
  UX wart worth noting.)
- **Root cause:** commander default when no subcommand is given; not overridden
  in `src/cli/run.ts` / `program.ts`.

### 8. README overstates the global-options-position constraint
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js countries --compact   # works: single-line JSON, exit 0
  node dist/src/cli/index.js get --compact 226768  # works, exit 0
  ```
  **Expected:** README says "Global options go **before** the command", implying
  they will not work afterwards.
  **Actual:** They work *after* the command too (commander `optsWithGlobals`), so
  the documentation is incorrect/over-restrictive. Harmless, but a doc defect.
- **Root cause:** README "Global options" section vs commander behavior in
  `src/cli/shared.ts:98` (`command.optsWithGlobals()`).

---

## Verified correct (probed, no bug)

- `get <real id>` returns full entry **with** HTML `content` (exit 0).
- `get <non-existent numeric id>` → upstream 404 → exit **4** (not `{}`). ✓
- `get` not-found via empty/multi/missing-envelope 200 responses → exit **4**
  (`ReiseNotFoundError`); the sole-entry-with-different-key tolerance works; an
  ambiguous multi-entry 200 is treated as not-found, not guessed. ✓
- `get` with `..`, `with space`, unicode (`Äüö`), trailing `/`, leading `-`
  (`-226768`), leading zeros — all correctly URL-encoded; no path traversal
  (`../travelwarning` → encoded `..%2F...` → 403 → exit 1). ✓
- `--warned-only` **does** filter on all four flags
  (`warning || partialWarning || situationWarning || situationPartWarning`);
  live data has 19 full + 27 partial-only countries and the partial-only country
  Kolumbien (201516) is correctly included; 46 total returned. ✓
- Umlauts are emitted raw (not `\uXXXX`-escaped) in **both** pretty and
  `--compact` output. ✓
- `summaries()`/`list` drop no per-country fields vs raw curl (deep-equal). ✓
- Network failures handled cleanly with exit 1: closed port (ECONNREFUSED), bad
  host (ENOTFOUND), `--timeout 1` (timeout), `--max-response-bytes 1` (size cap),
  `file://` base URL (unsupported-protocol guard). ✓
- Trailing slashes on `--base-url` are normalized. ✓
- Invalid/unknown command, unknown flag, missing required `get` id, too-many
  args → exit 1 with a usage error. ✓
- non-404 API errors (403) → exit 1, per README. ✓
- JSON parse failure on a 200 non-JSON body → exit 1 (`ReiseParseError`). ✓
