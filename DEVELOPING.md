# Developing & integrating

This document covers `reisewarnungen-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`reisewarnungen`) and a typed API client
(`ReisewarnungenClient`) for the
[Auswärtiges Amt travel-warning open-data API](https://www.auswaertiges-amt.de/opendata/travelwarning)
(`auswaertiges-amt.de/opendata/travelwarning`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed country summaries and the `response` envelope.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the travel-warning open-data API needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
reisewarnungen --help
```

## Library usage

```ts
import {
  ReisewarnungenClient,
  ReiseApiError,
  ReiseNotFoundError,
} from "@maschinenlesbar.org/reisewarnungen-cli";

const client = new ReisewarnungenClient(); // defaults to https://www.auswaertiges-amt.de

const countries = await client.summaries();          // CountryEntry[]
const warned = await client.summaries({ warnedOnly: true }); // any of the four flags (isWarned)
const detail = await client.get(countries[0]!.id);   // full warning incl. HTML content

try {
  await client.get("999999999");
} catch (err) {
  // Upstream may answer with a 404 (ReiseApiError) or a 200 whose envelope holds
  // no country entry (ReiseNotFoundError). Both signal "not found".
  if (err instanceof ReiseApiError) console.error(err.status, err.detail);
  if (err instanceof ReiseNotFoundError) console.error("not found:", err.contentId);
}
```

`get(contentId)` rejects a `contentId` that is not a string of ASCII digits
(`ReiseValidationError`, no request; the check is exported as `assertContentId`) and resolves to the entry keyed by `contentId` and **never** to a
different country: an envelope with no country entry throws `ReiseNotFoundError`,
one whose entries sit under other keys throws `ReiseParseError` rather than guessing.

### Client options

```ts
new ReisewarnungenClient({
  baseUrl: "https://www.auswaertiges-amt.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 / resets: backoff, or longer if Retry-After asks (<= 30 s)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

The constructor rejects an unknown option key (`timeout` for `timeoutMs`, with a
"did you mean" hint; a key set to `undefined` is fine) and range-checks the numeric
options before any request; it throws
`ReiseValidationError` (`Invalid maxRetries: Must be <= 10.`) for anything else:
`timeoutMs` an integer `0`..`MAX_TIMEOUT_MS` (2^31 - 1), `maxRetries` `0`..`MAX_RETRIES`
(10), `retryDelayMs` `0`..`MAX_RETRY_AFTER_MS` (30 000), and `maxRedirects` and
`maxResponseBytes` non-negative integers.
`undefined` keeps the default and `0` its documented meaning. A negative, `NaN` or
fractional value would otherwise switch the timeout or the size cap off, and `NaN` or
`Infinity` would leave retries or redirects unbounded. The rule is the exported
`intOption` / `intInRangeProblem`; the CLI's flags use the same one.

`baseUrl` must be an absolute `http:`/`https:` URL without a query or fragment (a
path prefix is fine; trailing slashes are dropped). The constructor checks the raw
value with the exported `validateBaseUrl` / `baseUrlProblem` and throws
`ReiseValidationError` (`Invalid baseUrl: Only "http:" and "https:" base URLs are
supported.`), a configuration error rather than a `ReiseNetworkError`, so retry
logic for outages never retries it. The CLI's `--base-url` uses the same rule and
messages.

`userAgent` goes into an HTTP header, so the constructor checks it too
(`assertHeaderValue` / `headerValueProblem`): a blank value, a C0 control character
other than tab (CR/LF included), DEL, or a character above U+00FF throws
`ReiseValidationError` (`Invalid userAgent: Value contains control characters.`)
instead of being sent blank, passed to a custom transport as is, or failing late
with Node's raw `TypeError`. Only an omitted `userAgent` selects the default
(`reisewarnungen-cli`). The default transport also turns any header Node refuses
into a `ReiseNetworkError` (`Invalid request: …`).

### Methods

`client.list()` (raw `response` map), `client.summaries()` (flattened array with ids),
`client.get(contentId)` (one full warning), `client.advice(contentId)` (the flags plus the
advice-against-travel sentences; the CLI's `advice`).

`advice(contentId)` fetches the advisory with `get` (same errors) and returns its flags,
`effective`/`lastModified` and `sentences` from the exported `adviceSentences(html)`
([`advice.ts`](src/client/advice.ts)): every sentence that matches one of
`ADVICE_PATTERNS` (abraten, warnen, Reisewarnung, (ver)meiden/gemieden/vermieden,
verzichten, unterlassen/unterbleiben, aufgefordert, nicht … reisen/aufsuchen/besuchen;
case-insensitive, Unicode word boundaries), with its heading path (`section`) and
`travel` (`TRAVEL_PATTERN`: Reise, Aufenthalt, Region, Gebiet, Provinz, Grenze, Landesteil,
…). The HTML is split at block elements (paragraphs, list items, headings, accordion
buttons), entities decoded and soft hyphens dropped; sentences split at `.`/`!`/`?` before
an upper-case start, but not after an abbreviation („z. B.", „o.g.", „bzw.", a one- or
two-digit ordinal); a sentence that ends in `:` before a list carries the list's items. The
flags record only the formal levels, so this is what keeps an all-false country from
reading as "advice only" when its text says „Vermeiden Sie … Reisen" (Türkei), „Meiden Sie
möglichst Reisen …" (Angola) or „… sollte … gemieden werden" (Bangladesch). An entry
without `content` is a `ReiseParseError`, never "no advice".

`summaries({ warnedOnly: true })` keeps only the countries with a warning of any
kind in force: the exported `isWarned(entry)` is true when **any** of `warning`,
`partialWarning`, `situationWarning` or `situationPartWarning` is `true`. The flags
can't be malformed by then: `list()`/`summaries()` and `get()` require `warning` and
`partialWarning` to be booleans on every entry (the situation flags may be absent, but are
booleans when present) and throw `ReiseParseError` naming the country and flag otherwise.
A non-boolean flag used to fail open — `"true"` or `1` dropped the country from
`--warned-only`, a renamed `Warning` left every country unwarned. It is the same rule the
CLI's `countries --warned-only` applies, because the CLI calls this method. A
`warnedOnly` that is not a boolean, options that are not an object, and an unknown key
(a misspelt `warnedonly`, `__proto__`) are rejected with `ReiseValidationError` before
any request — a JavaScript caller's typo no longer switches the filter off. Filtering on `c.warning` alone would miss partial and situation
warnings.

## Authentication internals

The Auswärtiges Amt travel-warning endpoint is **open data** — it requires no
API key or token. The client issues unauthenticated `GET` requests. There is
no `--api-key` flag, no env var, and nothing to configure.

**Credentials in a base URL.** A mirror or proxy behind a login can be given as
`--base-url https://user:password@host` (sent as HTTP Basic auth). The CLI never prints
that password: `run()` wraps its output (`withRedactedOutput`) so every line — commander's
usage errors that echo a rejected value, its own messages, library errors naming the
request URL — has the exact userinfo of every argument replaced by `***`, whatever
characters the password holds (`#`, `?`, `/`, spaces, quotes). The log replaces it in
each record's *message* (`redactionFor`), before the record is cut and escaped, and writes
the record to the raw stderr: the frame (time, level, topic) is never touched, and a
password with DEL, C1 or bidi characters is matched in its raw form. The library exports the
pieces: `redactUrl(url)`, `credentialsIn(value)` (the userinfo as written, also for a
value that doesn't parse) and `redactCredentials(text, list)`.

The library keeps the password out of what a caller logs, too: the engine holds the base
URL in a real `#private` field (so `console.log(client)`, `util.inspect` and
`JSON.stringify` don't show it), `ReiseApiError.url` and its message carry the URL with
the userinfo replaced by `***`, a redirect target is shown the same way, and error
bodies, details, transport error text and the `cause` chain are scrubbed of the
userinfo (raw and percent-decoded) before they reach an error.

**Plain `http:`.** `cleartextProblem(baseUrl, secrets?)` (exported) returns one sentence
when requests to `baseUrl` would travel unencrypted — `requests to <host> are sent
unencrypted (http:, not https:)`, or `the base URL's credentials are sent unencrypted to
<host> (http:, not https:)` when it carries userinfo — and `undefined` for `https:`, an
unparseable URL and a loopback host (`localhost`, 127.0.0.0/8, `::1`). `<host>` is
`url.host`, never the userinfo. The CLI's `action()` wrapper logs it as a `WARN` record of
`reisewarnungen.http` on stderr once per run, before the client is built; help, version and usage errors never
warn, and stdout and the exit code are unchanged. The library itself never warns.

**Credentials across redirects.** The engine takes the userinfo off the base URL and
sends it as a Basic `Authorization` header, attached per hop and only to requests on the
base URL's origin (scheme, host and port): a same-origin redirect keeps it, whether its
`Location` is relative or absolute; a redirect to another origin — another host or port,
or `http:` → `https:` — drops it; userinfo a server writes into its `Location` is
removed before the hop. A `401`/`403` after a redirect that dropped the credentials says
so in the `ReiseApiError` message (for `http:` → `https:`: "use an https base URL"). A
transport therefore never sees userinfo in `HttpRequest.url`, and it is told
`redirect: "manual"`: it must not follow redirects itself (`fetch` does by default). A
transport that reports a final `HttpResponse.url` on another origin than the request's
makes the call fail with a `ReiseNetworkError`.

**Cross-origin header stripping.** On a redirect that crosses an origin
boundary (different scheme, host, or port), the engine also strips sensitive headers
(`Authorization`, `Cookie`, `X-API-Key`, `Proxy-Authorization`,
`WWW-Authenticate`) before following it, so any credentials set via custom
headers are never forwarded to another host.

**Redirects not followed.** Only `301/302/303/307/308` with a parseable `Location`
are followed (up to `maxRedirects`; https->http and non-http(s) targets are refused
with a `ReiseNetworkError`). Any other 3xx, a missing or malformed `Location`, and a
hop past the limit throw a `ReiseApiError` whose `location` field and message name
the target: `redirect to <url> not followed`, with `(stopped after N redirects)` when
the limit stopped it, or `redirect not followed (no Location header)`.

## Architecture

```
src/
  client/
    types.ts     # TravelWarning / CountryEntry + the response envelope
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (per-hop credentials), transport contract, charset decoding, error mapping
    errors.ts    # ReiseError / ReiseApiError / ReiseNetworkError / ReiseParseError / ReiseValidationError + credential redaction
    validate.ts  # input rules (Problem functions) + assertValid / assertKnownKeys, shared with the CLI
    advice.ts    # adviceSentences: the advice-against-travel sentences of an advisory's HTML
    client.ts    # ReisewarnungenClient — list / summaries / get / advice over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # list / countries / get / advice
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The client unwraps the `{ response: ... }` envelope and offers a flattened `summaries()` view, since
  the raw response mixes a `lastModified` scalar in with the country-keyed entries.
- The full HTML warning text is only returned by the single-warning endpoint, so `get` is where `content` appears.
- The CLI is built around injectable `CliDeps`, so the whole program can be driven in-process by tests.

### Library / technical terms

**API client.** [`ReisewarnungenClient`](src/client/client.ts) — the typed
wrapper over the API (`list` / `summaries` / `get`). Usable as a library
independently of the CLI.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Custom transports.** The engine enforces the documented limits for every transport,
not only the built-in one. Each call runs under the overall `timeoutMs` deadline: the
transport gets an `AbortSignal` (`HttpRequest.signal`) that fires at the deadline, and
the call rejects then (`ReiseNetworkError: … Request timed out after …ms`) whether the
transport stops or not, so a `fetch` or `node:http` transport can't hang a caller. The
engine checks `maxResponseBytes` on the body it gets back. A transport may return the
body as a Buffer, any `ArrayBuffer` view (fetch's `Uint8Array`, from any realm) or an
`ArrayBuffer`, and the headers as a plain record in any case, a `Headers` object or a
`Map` (so `Retry-After` and `Location` are read from all of them). Whatever it throws,
and a response without a valid status, headers or body, becomes a `ReiseNetworkError`
(`GET <url> failed: <reason>`, the original as `cause`); a reset reported as Node's
`ECONNRESET`/`EPIPE`/`ECONNABORTED` or undici's `UND_ERR_SOCKET` anywhere in the `cause`
chain is retried like a `503` (GET only; `isTransientNetworkError` tells them apart).

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON
responses and maps errors. Sits between the client and the transport.

**RawResponse.** The result of `request()` — `{ data: Buffer, contentType,
status }`, the raw bytes `getJson()` then decodes: by the charset the Content-Type
names (UTF-8 when it names none), a leading BOM dropped; an unknown charset label
is a `ReiseParseError`, and so is a body that isn't JSON (naming a non-JSON
Content-Type such as `text/html`, the usual maintenance page).

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `ReiseApiError` (non-2xx,
carries `status`/`detail`), `ReiseNotFoundError` (a 2xx response with no matching
entry; synthetic `status` 404), `ReiseNetworkError` (transport
failure/timeout, a redirect to a refused target, or a request Node refuses —
never a bad configuration value), `ReiseParseError` (bad JSON, or a 2xx body that is not the
`{ "response": { … } }` envelope — on `list` and `get` alike) and
`ReiseValidationError` (an input the library rejects before any request: a bad
option, option key or type, content id, or `isWarned` argument — never a raw
`TypeError`), all extending `ReiseError`. Server text in a message (an error
`detail`, a redirect target, a transport's error text) and the URL it names are cut
at 500 characters, never inside a surrogate pair (`cutText`), so the message stays
well-formed; a redirect target, a Content-Type or a charset the message names at
`MAX_QUOTED_LENGTH` (200, `cutForMessage`, both exported); `ReiseApiError.body` keeps the full body. The client's own messages
that quote the server (the text of an error envelope sent with a 2xx status, a country
name and a malformed flag value, the ids a `contentList` names without an entry) go
through the exported `serverTextForMessage`: one line, no control (C0, DEL, C1) or bidi
characters, at most 200 characters (cut the same way). A content id (or the path that
ends in one) is quoted at most 500 characters long in every message — not found, shape
and parse errors, `assertContentId`'s — while `ReiseNotFoundError.contentId` keeps it
whole. The CLI maps a `404` (real or synthetic) on `get` to exit
code `4`, other errors to `1` — including a `404` on `list`/`countries`, where it
means the endpoint itself is missing, not a country, and a `ReiseValidationError`,
which gets the same exit code commander gives a usage error.

**Input validation.** Every rule about what a request may contain lives in the
library, in [`validate.ts`](src/client/validate.ts) or next to the option it
guards, as an exported `…Problem(value)` function that returns the reason a value
is invalid (or `undefined`). The library enforces it with `assertValid(name,
value, problem)`, which throws `ReiseValidationError` with the message
`Invalid <name>: <reason>` before any request (methods that return a promise
reject; constructors throw). The CLI's option parsers call the same functions and
turn the reason into a usage error, so the CLI keeps no rules of its own. Tests
check this with the `parity()` helper in `test/helpers.ts`, which sends one input
through `run()` and through the library on one recording mock transport.

**Retry / backoff.** Transient `429` (rate limited) and `503` responses are
retried automatically (`--max-retries` / `maxRetries`, `0`–`MAX_RETRIES` (10), default `2`). The
backoff is the floor: `retryDelayMs * attempt` for a `503` (and a reset connection), and for a
`429` at least 1 s (or `retryDelayMs`, if larger), doubling per attempt, at most 30 s. A
`Retry-After` (delay-seconds or an IMF-fixdate, parsed strictly by the exported
`parseRetryAfter`) can lengthen a wait, never shorten it, so `Retry-After: 0` or a past date
never makes a zero-delay burst. A `Retry-After` above `MAX_RETRY_AFTER_MS` (30 s) is not
retried: the error surfaces at once, and its message names the requested wait and says that
retrying sooner won't help. `retryDelayMs` is an integer `0`..`MAX_RETRY_AFTER_MS`.
`ReiseApiError` exposes `isRetryable` (true for `429`/`503`).

**maxResponseBytes.** A hard cap on the response body size (default 100 MiB;
`0` disables it) that aborts the request if exceeded, defending against memory
exhaustion from a hostile or buggy endpoint. The default transport aborts as soon as
the cap is passed; the engine also checks the body any transport returns. The message
names both spellings: `Response exceeded the size limit of N bytes (maxResponseBytes;
--max-response-bytes on the CLI)`.

**List shape check.** `list()` (and so `summaries()`, `countries`) checks the
unwrapped envelope before returning it: an `error` member (an error envelope sent
with a 2xx status), a content-id key whose value is not an object, no country entry
at all, or a `contentList` naming ids without an entry is a `ReiseParseError` (exit
`1`). The live list holds about 200 countries, so an empty one is a broken answer —
never "no travel warnings". `get` reports an error envelope the same way instead of
"not found".

**Entry lookup on `get`.** The single-warning endpoint keys its one entry under
the requested content id, and `get` returns **only** that entry. An envelope with
no country entry at all is **not found** (`ReiseNotFoundError`, exit `4`); one
whose country entries sit under other keys is a broken answer (`ReiseParseError`,
exit `1`), never read as the requested country — a travel-safety tool must not
answer with a different country. (Earlier versions accepted a *sole* entry under
any key.)

**Query builder.** [`buildQueryString`](src/client/query.ts) — a dependency-free
serialiser: omits `undefined`/`null`, repeats keys for arrays, renders booleans
as `true`/`false`, dates as ISO-8601, and encodes spaces as `%20` (not `+`).

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `reisewarnungen.<area>`. `--log-format text` (the
default) writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path, can split it,
forge another one or steer the terminal. Before that a lone surrogate (half a
character, which jq rejects, stopping the whole stream) becomes U+FFFD (`toWellFormed`),
and a message longer than `MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a
code point and ends in `… (N more characters)`. The areas are `cli` (usage errors, commander's messages, unexpected errors, the
library's validation and parse errors), `api` (the API's answers: an HTTP error status, a
country the response doesn't hold, a `404` on the list endpoint), `http` (the connection,
the cleartext warning) and `output` (`-o`). Code logs through `logOf(deps)` and never
writes diagnostics with `io.err` directly. `run()` builds the logger from argv before
commander parses it, so commander's own usage errors are records too, and with the run's
redaction (`withRedactedOutput`), which replaces a secret in the message only, before it
is escaped: the frame is never touched, and a secret is kept out of the log in either
format. `CliDeps.now`
makes the timestamps testable. stdout carries data only. Only the bin shim's
`Output error: …` (a failed write to stdout, `handleOutputErrors`, outside `run()`) stays a
plain line. Conformance test P23 checks all of this, and its body is shared across the
*-cli repos.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — response unwrapping, the flattened `summaries()` view, the `get` entry lookup (not-found vs. entries under other keys) — mocked transport.
- **`validate.test.ts`** — `assertValid`, the `ReiseValidationError` exit-code mapping and the `parity()` helper.
- **`cli.test.ts`** — end-to-end command parsing, per-flag `--warned-only` filtering, pretty vs `--compact` output, `-o -`, and exit codes (network/parse → 1, not-found → 4) — mocked client.
- **`log.test.ts`** — the record helpers of `src/cli/log.ts` on their own
  (`escapeForRecord`, `formatLogRecord`); the CLI-level checks are P23's.
- **`advice.test.ts`** — `adviceSentences` on the advisory shapes seen live (Türkei, Angola, Bangladesch, Mexiko's region lists, Tunesien's sentence split around a list), every documented phrasing, abbreviations, `client.advice` and the `advice` command.
- **`conformance-p*.test.ts`** — the shared checks of the 2026-10-05 fix plan, one file per pattern (P1 CLI redaction, P2 library redaction, P3 credentials across redirects, P4 base-URL rules, P5 transport contract, P6 retry policy, P7 pipes and exit codes — spawns the built bin, P8/P9/P13 responses and error classes, P10 strict options, P20 the stderr warning for a plain-`http:` base URL, P21 README links only to files the npm package ships — others by their GitHub URL, P23 the log on stderr — its body takes the usage-error exit code from the adapter's `USAGE_EXIT`, `1` here). Only their `adapter` block is repo-specific.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch from the release tag (`gh workflow run publish.yml --ref vX.Y.Z`; the version is the tag's): publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/reisewarnungen-cli/> in English
and <https://maschinenlesbar-org.github.io/reisewarnungen-cli/de/> in German — is built from
`site/` with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web
components and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the
TypeDoc API reference under `/api/`. Its content comes from this repository: the README intro
and quick start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`),
`Usage.md`, `GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill
examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are
`site/_config.yml` and `site/_data/project.yml` (the German intro and the access requirements);
the rest of `site/` is identical in every maschinenlesbar.org CLI, so change it in all of them
together. When the README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/reisewarnungen-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
