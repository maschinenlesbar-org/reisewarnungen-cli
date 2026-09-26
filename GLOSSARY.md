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
object. The client unwraps it: `list()` returns `response`. A `200` whose body
is not such an envelope (`null`, `{}`, another API's JSON, a `response` that is
not an object) is surfaced as a `ReiseParseError` (exit `1`) on `list`,
`countries` **and** `get`, rather than masked as an empty success or reported as
"not found".

**`lastModified`.** An envelope member (a Unix-epoch timestamp, in
**seconds**) carried alongside the country entries — nominally when the dataset
was last changed, but it lags far behind the entries' own `lastModified` values
(`1757063288`, 2025-09-05, when checked on 2026-09-15). It is **not** a country, so
`summaries()` skips it when flattening.

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

**countryCode.** The ISO 3166-1 alpha-2 (two-letter) country code, e.g. `TH`,
`JO`. Kosovo, which has no official ISO code, uses `XK`.

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

**effective.** A Unix-epoch timestamp (**seconds**): when the current advice
took effect. Each entry's own `lastModified` uses the same unit.

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
retried automatically (`--max-retries`, `0`–`10`, default `2`). Each retry waits
the server's `Retry-After` (seconds or an HTTP date); without a usable one the
delay grows linearly (200 ms, 400 ms, …). A `Retry-After` above 30 s is not
waited out: the error is reported at once.

**Redirects.** The engine follows up to `maxRedirects` (default `5`) HTTP
redirects (`301/302/303/307/308`), resolving `Location` relative to the current
URL. On a **cross-origin** redirect it strips sensitive headers
(`Authorization`, `Cookie`, `X-API-Key`, `Proxy-Authorization`,
`WWW-Authenticate`) so credentials are never leaked to another host.

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

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `ReisewarnungenClient`, the request engine, transport, retry/backoff, error
> types, the `get` entry lookup — now live in **[DEVELOPING.md](DEVELOPING.md)**.
