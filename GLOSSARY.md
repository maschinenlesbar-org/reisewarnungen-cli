# Glossary

A reference for the domain concepts and project-specific terms used throughout
`reisewarnungen-cli`. The domain (German foreign-office travel advice) is German;
this glossary gives the English term used in the CLI/client alongside the
original German where one exists.

> **Translation table.** The CLI/client follows these:
>
> | German | English / client term |
> | --- | --- |
> | Reisewarnung | (full) travel warning |
> | Teilreisewarnung | partial / regional warning |
> | Reise- und Sicherheitshinweise | travel and safety advice |
> | Auswärtiges Amt | Federal Foreign Office |
> | Land | country |
> | Inhalt | content |

---

## The API and its publisher

**Auswärtiges Amt (AA) — Federal Foreign Office.** The German federal ministry
for foreign affairs. It issues the official travel and safety advice this tool
reads. Web home and data host: `auswaertiges-amt.de`.

**Travel-warning open-data API.** The open, no-authentication endpoint published
by the AA at `https://www.auswaertiges-amt.de/opendata/travelwarning`. It returns
the AA's per-country travel and safety advice as JSON. Read-only (`GET`); no API
key is required. This is the only API the tool wraps; `DEFAULT_BASE_URL` is
`https://www.auswaertiges-amt.de` and the resource path is
`/opendata/travelwarning`.

**Reise- und Sicherheitshinweise (travel and safety advice).** The AA's
country-by-country guidance for travellers: entry rules, security situation,
health, and — where the situation warrants — an explicit warning. The advice text
is delivered as HTML in the `content` field.

---

## Endpoints / resources

**List endpoint (`GET /opendata/travelwarning`).** Returns *all* countries at
once as a map of content id -> country summary, plus envelope members. The
per-country summaries here do **not** include the HTML `content`. CLI: `list`
(raw) and `countries` (flattened).

**Single-warning endpoint (`GET /opendata/travelwarning/{contentId}`).** Returns
one country's full advice, with the HTML `content` populated. CLI: `get`.

---

## Response shape

**`response` envelope.** Every API response is wrapped in a top-level `response`
object. The client unwraps it: `list()` returns `response`; a `200` whose body
lacks the `response` envelope is surfaced as a `ReiseParseError` rather than
masked as an empty success.

**`lastModified`.** An envelope member (a Unix-epoch timestamp, in
milliseconds) carried alongside the country entries — when the dataset was last
changed. It is **not** a country, so `summaries()` skips it when flattening.

**`contentList`.** An envelope member: an array of all content ids the upstream
includes alongside the per-country summaries. Also **not** a country, so
`summaries()` skips it.

**TravelWarning.** One country's entry. Fields the client surfaces: `title`,
`countryCode`, `iso3CountryCode`, `countryName`, the four boolean warning flags
(below), `lastModified`, `effective`, `lastChanges`, `content` (HTML, single
endpoint only), and `disclaimer`.

**CountryEntry.** A `TravelWarning` augmented with its `id` (the content id),
produced by `summaries()` — the flattened, array-shaped view of the list.

---

## Identifiers & codes

**content id (`contentId`).** The numeric-string key under which a country's
entry is stored in the `response` map (e.g. `226768`). It is the `id` field on a
`CountryEntry` and the required argument to `get <contentId>`. It is *not* an ISO
country code. An empty content id is rejected as a usage error rather than sent
upstream.

**countryCode.** The country's identifier as supplied by the AA. (The AA uses
its own numeric country coding alongside the standard ISO codes.)

**iso3CountryCode.** The ISO 3166-1 alpha-3 (three-letter) country code, e.g.
`DEU`, `FRA`.

**countryName.** The human-readable country name (German).

---

## Warning flags

The four boolean fields the client surfaces, in increasing specificity. A
country counts as "warned" (the `countries --warned-only` filter) if **any** of
them is true.

**warning.** A full travel warning (Reisewarnung) is in force for the whole
country — the AA's strongest advice against travel.

**partialWarning.** A partial/regional warning (Teilreisewarnung) is in force —
the warning applies to specific regions rather than the whole country.

**situationWarning.** A situation-specific warning is in force (tied to a
particular event or circumstance).

**situationPartWarning.** A situation-specific *partial* warning — situational
and limited to part of the country.

---

## Other entry fields

**title.** The advice document's title.

**effective.** A Unix-epoch timestamp (milliseconds): when the current advice
took effect.

**lastChanges.** A short, human-readable note describing what changed in the
latest revision of the advice.

**content.** The full advice text as **HTML**. Present only on the
single-warning endpoint, so it appears on `get` results, not on `list` /
`countries`.

**disclaimer.** The AA's standard legal disclaimer text accompanying the advice.

---

## API & transport concepts

**Read-only, no auth.** The endpoint serves data over `GET` with no key, token
or login. The client only reads; it issues no writes.

**Retry / backoff.** Transient `429` (rate limited) and `503` responses are
retried automatically with linear backoff (`--max-retries`, default `2`;
base delay grows with each attempt).

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP
redirects (`301/302/303/307/308`), resolving `Location` relative to the current
URL. On a **cross-origin** redirect it strips sensitive headers
(`Authorization`, `Cookie`, `Proxy-Authorization`, `WWW-Authenticate`) so
credentials are never leaked to another host.

**maxResponseBytes.** A hard cap on the response body size (default 100 MiB;
`0` disables it) that aborts the request if exceeded, defending against memory
exhaustion from a hostile or buggy endpoint.

**Sole-entry tolerance.** On `get`, the single-warning endpoint normally keys its
one entry under the requested content id. As a tolerance for that key ever
differing, a *sole* non-`lastModified` object entry is accepted as the result;
but an ambiguous (multi-entry) or empty response is treated as **not found**
rather than risk returning a different country than requested.

---

## Project / technical terms

**API client.** [`ReisewarnungenClient`](src/client/client.ts) — the typed
wrapper over the API (`list` / `summaries` / `get`). Usable as a library
independently of the CLI.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, follows redirects, decodes JSON/raw
responses and maps errors. Sits between the client and the transport.

**RawResponse.** The result of a raw request: `{ data: Buffer, contentType,
status }` — raw bytes, never lossily decoded.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`outBinary`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Error types.** [`errors.ts`](src/client/errors.ts): `ReiseApiError` (non-2xx,
carries `status`/`detail`), `ReiseNotFoundError` (a 2xx response with no matching
entry; synthetic `status` 404), `ReiseNetworkError` (transport
failure/timeout), `ReiseParseError` (bad JSON / missing envelope), all extending
`ReiseError`. The CLI maps a `404` (real or synthetic) to exit code `4`, other
errors to `1`.
