# reisewarnungen-cli

A TypeScript **API client** and **command-line interface** for the open
[Auswärtiges Amt travel-warning API](https://www.auswaertiges-amt.de/opendata/travelwarning)
(`auswaertiges-amt.de`) — official German **travel and safety warnings** by country.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed country summaries and the `response` envelope.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the travel-warning open-data API needs no key; this client only reads.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
reisewarnungen --help
```

---

## CLI usage

The API wraps everything in a top-level `response`; this CLI prints the unwrapped
content. `--compact` for a single line.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://www.auswaertiges-amt.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |
| `-o, --output <file>` | Write the command output to this file instead of stdout |

Global options may be given **before or after** the command, e.g.
`reisewarnungen --compact countries` or `reisewarnungen countries --compact`.

### Commands

```text
list                          all warnings, keyed by content id (raw response)
countries [--warned-only]     flattened overview (id, country, warning flags)
get <contentId>               one country's full warning (with HTML content)
```

The `<contentId>` is the numeric key from `list` / the `id` field from `countries`.

### Examples

```bash
# Compact overview of every country
reisewarnungen countries

# Only countries with a warning of any kind in force
reisewarnungen countries --warned-only

# Full warning text for one country (id from `countries`)
reisewarnungen get 226768
```

Exit codes: `0` success, `4` when a country is not found (an upstream `404` **or** a
`get` whose response contains no matching entry), `1` for any other error. Usage errors
exit with commander's own non-zero code, while `--help` / `--version` exit `0`.

---

## Library usage

```ts
import {
  ReisewarnungenClient,
  ReiseApiError,
  ReiseNotFoundError,
} from "reisewarnungen-cli";

const client = new ReisewarnungenClient(); // defaults to https://www.auswaertiges-amt.de

const countries = await client.summaries();          // CountryEntry[]
const warned = countries.filter((c) => c.warning);
const detail = await client.get(countries[0]!.id);   // full warning incl. HTML content

try {
  await client.get("does-not-exist");
} catch (err) {
  // Upstream may answer with a 404 (ReiseApiError) or a 200 whose envelope holds
  // no matching entry (ReiseNotFoundError). Both signal "not found".
  if (err instanceof ReiseApiError) console.error(err.status, err.detail);
  if (err instanceof ReiseNotFoundError) console.error("not found:", err.contentId);
}
```

`get(contentId)` resolves to the matching entry, tolerating the single-warning
endpoint keying its sole entry under a different id, but it **never** returns a
different country than requested: an ambiguous (multi-entry) or empty response
throws `ReiseNotFoundError` rather than guessing.

### Client options

```ts
new ReisewarnungenClient({
  baseUrl: "https://www.auswaertiges-amt.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Methods

`client.list()` (raw `response` map), `client.summaries()` (flattened array with ids),
`client.get(contentId)` (one full warning).

---

## Architecture

```
src/
  client/
    types.ts     # TravelWarning / CountryEntry + the response envelope
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (cross-origin credential strip), JSON/raw decoding, error mapping
    errors.ts    # ReiseError / ReiseApiError / ReiseNetworkError / ReiseParseError
    client.ts    # ReisewarnungenClient — list / summaries / get over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # list / countries / get
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

---

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — response unwrapping, the flattened `summaries()` view, the `get` sole-entry tolerance and its not-found / ambiguous-match handling — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, per-flag `--warned-only` filtering, pretty vs `--compact` output, and exit codes (network/parse → 1, not-found → 4) — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

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
