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
const warned = countries.filter((c) => c.warning);
const detail = await client.get(countries[0]!.id);   // full warning incl. HTML content

try {
  await client.get("does-not-exist");
} catch (err) {
  // Upstream may answer with a 404 (ReiseApiError) or a 200 whose envelope holds
  // no country entry (ReiseNotFoundError). Both signal "not found".
  if (err instanceof ReiseApiError) console.error(err.status, err.detail);
  if (err instanceof ReiseNotFoundError) console.error("not found:", err.contentId);
}
```

`get(contentId)` resolves to the entry keyed by `contentId` and **never** to a
different country: an envelope with no country entry throws `ReiseNotFoundError`,
one whose entries sit under other keys throws `ReiseParseError` rather than guessing.

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

## Authentication internals

The Auswärtiges Amt travel-warning endpoint is **open data** — it requires no
API key or token. The client issues unauthenticated `GET` requests. There is
no `--api-key` flag, no env var, and nothing to configure.

**Cross-origin credential stripping.** On a redirect that crosses an origin
boundary (different scheme, host, or port), the engine strips sensitive headers
(`Authorization`, `Cookie`, `X-API-Key`, `Proxy-Authorization`,
`WWW-Authenticate`) before following it, so any credentials set via custom
headers are never forwarded to another host.

## Architecture

```
src/
  client/
    types.ts     # TravelWarning / CountryEntry + the response envelope
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, redirects (cross-origin credential strip), JSON decoding, error mapping
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
- The CLI is built around injectable `CliDeps`, so the whole program can be driven in-process by tests.

### Library / technical terms

**API client.** [`ReisewarnungenClient`](src/client/client.ts) — the typed
wrapper over the API (`list` / `summaries` / `get`). Usable as a library
independently of the CLI.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON
responses and maps errors. Sits between the client and the transport.

**RawResponse.** The result of `request()` — `{ data: Buffer, contentType,
status }`, the raw bytes `getJson()` then decodes.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `ReiseApiError` (non-2xx,
carries `status`/`detail`), `ReiseNotFoundError` (a 2xx response with no matching
entry; synthetic `status` 404), `ReiseNetworkError` (transport
failure/timeout), `ReiseParseError` (bad JSON, or a 2xx body that is not the
`{ "response": { … } }` envelope — on `list` and `get` alike), all extending
`ReiseError`. The CLI maps a `404` (real or synthetic) to exit code `4`, other
errors to `1`.

**Retry / backoff.** Transient `429` (rate limited) and `503` responses are
retried automatically with linear backoff (`--max-retries`, default `2`).
`ReiseApiError` exposes `isRetryable` (true for `429`/`503`).

**maxResponseBytes.** A hard cap on the response body size (default 100 MiB;
`0` disables it) that aborts the request if exceeded, defending against memory
exhaustion from a hostile or buggy endpoint.

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

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry, redirects — mocked transport.
- **`client.test.ts`** — response unwrapping, the flattened `summaries()` view, the `get` entry lookup (not-found vs. entries under other keys) — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, per-flag `--warned-only` filtering, pretty vs `--compact` output, and exit codes (network/parse → 1, not-found → 4) — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
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
